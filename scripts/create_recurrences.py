"""
create_recurrences.py — Vidai to Mulai
GitHub Actions cron script — runs daily.
Checks recurrence_schedule for due entries and creates new gig instances.

Schedule: defined in .github/workflows/recurrence.yml
Secrets:  SUPABASE_URL, SUPABASE_SERVICE_KEY (service role key — not anon)
"""

import os
import sys
from datetime import date, timedelta
from dateutil.relativedelta import relativedelta
from supabase import create_client, Client

# ── CONFIG ────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')  # service role key

if not SUPABASE_URL or not SUPABASE_KEY:
    print('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set')
    sys.exit(1)

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

TODAY = date.today().isoformat()

# ── HELPERS ───────────────────────────────────────────────────────────────

def calc_next_run(from_date: str, frequency: str) -> str:
    """Calculate next run date from a given date and frequency."""
    d = date.fromisoformat(from_date)
    if frequency == 'weekly':
        d = d + timedelta(weeks=1)
    elif frequency == 'fortnightly':
        d = d + timedelta(weeks=2)
    elif frequency == 'monthly':
        d = d + relativedelta(months=1)
    return d.isoformat()

def count_instances(parent_code: str) -> int:
    """Count existing instances for a recurring parent gig."""
    res = db.from_('gigs') \
        .select('gig_id', count='exact') \
        .like('gig_code', f'{parent_code}_%') \
        .execute()
    return res.count or 0

def generate_instance_code(parent_code: str) -> str:
    """Generate the next instance code: PARENT_001, PARENT_002 ..."""
    n = count_instances(parent_code) + 1
    return f'{parent_code}_{str(n).zfill(3)}'

# ── MAIN ──────────────────────────────────────────────────────────────────

def run():
    print(f'Running recurrence check for {TODAY}')

    # Fetch all active schedules due today or earlier
    res = db.from_('recurrence_schedule') \
        .select('*, gigs(*)') \
        .eq('is_active', True) \
        .lte('next_run_date', TODAY) \
        .execute()

    schedules = res.data or []
    print(f'Found {len(schedules)} due schedule(s)')

    created = 0
    skipped = 0

    for sched in schedules:
        parent = sched.get('gigs')
        if not parent:
            print(f'  SKIP schedule {sched["schedule_id"]} — parent gig not found')
            skipped += 1
            continue

        # Check end date
        end_date = sched.get('end_date')
        if end_date and TODAY > end_date:
            print(f'  DEACTIVATE {parent["gig_code"]} — end date {end_date} passed')
            db.from_('recurrence_schedule') \
                .update({'is_active': False}) \
                .eq('schedule_id', sched['schedule_id']) \
                .execute()
            skipped += 1
            continue

        # Check recurrence_stopped on parent
        if parent.get('recurrence_stopped'):
            print(f'  DEACTIVATE {parent["gig_code"]} — recurrence stopped')
            db.from_('recurrence_schedule') \
                .update({'is_active': False}) \
                .eq('schedule_id', sched['schedule_id']) \
                .execute()
            skipped += 1
            continue

        # Generate instance code
        instance_code = generate_instance_code(parent['gig_code'])
        rover_id      = sched.get('current_rover_id') or parent.get('rover_id')

        # Build new gig instance
        new_gig = {
            'gig_code':            instance_code,
            'project_id':          parent.get('project_id'),
            'category_id':         parent.get('category_id'),
            'parent_gig_id':       parent['gig_id'],
            'title':               parent.get('title'),
            'description':         parent.get('description'),
            'pacer_id':            parent.get('pacer_id'),
            'rover_id':            rover_id,
            'cadence':             'recurring',
            'scale':               parent.get('scale', 'minor'),
            'setting':             parent.get('setting', 'field'),
            'skill_level':         parent.get('skill_level', 'unskilled'),
            'status':              'placed',
            'date_placed':         TODAY,
            'date_due':            sched.get('next_run_date'),
            'recurrence_frequency': sched.get('frequency'),
        }

        insert_res = db.from_('gigs').insert(new_gig).execute()

        if insert_res.data:
            print(f'  CREATED {instance_code} (rover: {rover_id})')
            created += 1
        else:
            print(f'  ERROR creating {instance_code}: {insert_res}')
            skipped += 1
            continue

        # Advance next_run_date on schedule
        next_run = calc_next_run(sched['next_run_date'], sched['frequency'])
        db.from_('recurrence_schedule') \
            .update({'next_run_date': next_run}) \
            .eq('schedule_id', sched['schedule_id']) \
            .execute()
        print(f'  ADVANCED schedule next_run to {next_run}')

    print(f'\nDone — {created} created, {skipped} skipped')

if __name__ == '__main__':
    run()
