"""
create_recurrences.py — Vidai to Mulai
GitHub Actions cron script — runs daily.
Checks recurrence_schedule for due entries and creates new gig instances.

Also runs a second daily pass — reset_orphaned_gigs() — that resets any
non-completed gig whose Lead or Doer has gone missing/inactive back to
'placed'. Kept in this same script (rather than a DB trigger or separate
job) to stay consistent with the app's existing app-layer/cron-layer
pattern for business rules.

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
    """Count direct children only — not grandchildren.
    A direct child has exactly one more segment than the parent.
    e.g. parent HOME_RECYCLE_R_001 has 4 parts;
    direct child HOME_RECYCLE_R_001_001 has 5 parts.
    """
    res = db.from_('gigs') \
        .select('gig_code') \
        .like('gig_code', f'{parent_code}_%') \
        .execute()

    parent_parts = len(parent_code.split('_'))
    direct_children = [
        g for g in (res.data or [])
        if len(g['gig_code'].split('_')) == parent_parts + 1
    ]
    return len(direct_children)

def generate_instance_code(parent_code: str) -> str:
    """Generate the next instance code: PARENT_001, PARENT_002 ..."""
    n = count_instances(parent_code) + 1
    return f'{parent_code}_{str(n).zfill(3)}'

# ── MAIN: SPAWN DUE RECURRING INSTANCES ─────────────────────────────────

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

        # Guard — never allow an instance to spawn children
        if parent.get('parent_gig_id'):
            print(f'  DEACTIVATE schedule {sched["schedule_id"]} — parent {parent["gig_code"]} is itself an instance')
            db.from_('recurrence_schedule') \
                .update({'is_active': False}) \
                .eq('schedule_id', sched['schedule_id']) \
                .execute()
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

        # Build new gig instance. Status is 'matched', not 'placed' — the
        # instance is copying a Lead+Doer straight from the parent's
        # schedule, so (same as a manually-created one-off gig, and same
        # as spawnAdhocInstance() in vtm_api.js) there's nothing left to
        # wait on.
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
            'status':              'matched',
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

# ── DAILY SWEEP: RESET GIGS WITH MISSING/INACTIVE LEAD OR DOER ──────────
# Any non-completed gig whose pacer_id or rover_id points at a user who
# is missing (deleted) or inactive (deactivated in create_user.html) has
# its status reset to 'placed'. Completed gigs are left untouched — the
# work already happened. A gig already at 'placed' is skipped (nothing
# to do). This is the automatic side of "missing Lead/Doer data resets
# the gig back to Placed" — the create_gig.js save form already blocks
# saving a gig without both, so this only ever fires when a user gets
# deactivated/deleted *after* a gig already pointed at them.

def reset_orphaned_gigs():
    print('\nChecking for gigs with missing/inactive Lead or Doer...')

    gigs_res = db.from_('gigs') \
        .select('gig_id, gig_code, status, pacer_id, rover_id') \
        .neq('status', 'completed') \
        .execute()

    gigs = gigs_res.data or []
    if not gigs:
        print('No non-completed gigs to check')
        return

    user_ids = set()
    for g in gigs:
        if g.get('pacer_id'):
            user_ids.add(g['pacer_id'])
        if g.get('rover_id'):
            user_ids.add(g['rover_id'])

    active_ids = set()
    if user_ids:
        users_res = db.from_('vtm_users') \
            .select('user_id, active') \
            .in_('user_id', list(user_ids)) \
            .execute()
        active_ids = {
            u['user_id'] for u in (users_res.data or [])
            if u.get('active') is not False
        }

    reset_count = 0
    for g in gigs:
        pacer_ok = bool(g.get('pacer_id')) and g['pacer_id'] in active_ids
        rover_ok = bool(g.get('rover_id')) and g['rover_id'] in active_ids

        if pacer_ok and rover_ok:
            continue  # both assignees present and active — nothing to do

        if g['status'] == 'placed':
            continue  # already placed — nothing to reset

        db.from_('gigs') \
            .update({'status': 'placed'}) \
            .eq('gig_id', g['gig_id']) \
            .execute()
        print(f'  RESET {g["gig_code"]} to placed — missing/inactive Lead or Doer')
        reset_count += 1

    print(f'Reset {reset_count} gig(s) to placed')

if __name__ == '__main__':
    run()
    reset_orphaned_gigs()
