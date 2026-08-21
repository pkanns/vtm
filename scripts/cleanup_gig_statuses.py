"""
cleanup_gig_statuses.py — Vidai to Mulai
ONE-TIME cleanup script — run manually, once. NOT wired into any cron job
or GitHub Action; there is no scheduled trigger for this file.

Applies the new gig-status rules retroactively to existing data:

  1. MASTERS PINNED TO PLACED
     Any master gig (cadence='recurring', no parent_gig_id — covers both
     true adhoc templates and scheduled recurring parents) not already
     'placed' is reset to 'placed'. Masters never move past Placed.

  2. ONE-OFFS/INSTANCES ADVANCED PAST PLACED
     Any non-master gig currently sitting in 'placed' is advanced to
     'matched'. Under the OLD rules, a gig only reached 'placed' with a
     confirmed Lead + Doer already set, so this is just the new default
     applied retroactively — it does not touch gigs already further
     along the pipeline (aligned/in_progress/delivered/completed).

  3. ORPHANS RESET TO PLACED
     Any non-completed gig whose Lead or Doer is missing or inactive is
     reset to 'placed' (skipped if already 'placed'). Checked BEFORE
     rule 2 is applied, so an orphaned gig doesn't get advanced to
     'matched' and then immediately reset.

Order matters: for each gig — master check first, then orphan check,
then the placed→matched advance. A gig only ever gets ONE status change
applied by this script.

Run once, review the printed summary, then archive/delete this script.
Requires the same SUPABASE_URL / SUPABASE_SERVICE_KEY env vars as
create_recurrences.py (service role key — not anon).

Usage:
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python scripts/cleanup_gig_statuses.py
"""

import os
import sys
from supabase import create_client, Client

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')

if not SUPABASE_URL or not SUPABASE_KEY:
    print('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set')
    sys.exit(1)

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def cleanup():
    res = db.from_('gigs') \
        .select('gig_id, gig_code, status, cadence, parent_gig_id, pacer_id, rover_id') \
        .execute()
    gigs = res.data or []
    print(f'Loaded {len(gigs)} gig(s)\n')

    users_res = db.from_('vtm_users').select('user_id, active').execute()
    active_ids = {
        u['user_id'] for u in (users_res.data or [])
        if u.get('active') is not False
    }

    reset_masters          = 0
    reset_missing_assignee = 0
    advanced_oneoffs       = 0
    untouched              = 0

    for g in gigs:
        is_master = g.get('cadence') == 'recurring' and not g.get('parent_gig_id')
        status    = g.get('status')

        # Rule 1 — masters pinned to placed
        if is_master:
            if status != 'placed':
                db.from_('gigs').update({'status': 'placed'}).eq('gig_id', g['gig_id']).execute()
                print(f'  MASTER   {g["gig_code"]}: {status} -> placed')
                reset_masters += 1
            else:
                untouched += 1
            continue

        # Rule 3 — missing/inactive assignee (skip entirely if already completed)
        if status != 'completed':
            pacer_ok = bool(g.get('pacer_id')) and g['pacer_id'] in active_ids
            rover_ok = bool(g.get('rover_id')) and g['rover_id'] in active_ids

            if not pacer_ok or not rover_ok:
                if status != 'placed':
                    db.from_('gigs').update({'status': 'placed'}).eq('gig_id', g['gig_id']).execute()
                    print(f'  ORPHAN   {g["gig_code"]}: {status} -> placed (missing/inactive Lead or Doer)')
                    reset_missing_assignee += 1
                else:
                    untouched += 1
                continue

        # Rule 2 — one-off/instance sitting in placed -> matched
        if status == 'placed':
            db.from_('gigs').update({'status': 'matched'}).eq('gig_id', g['gig_id']).execute()
            print(f'  ONEOFF   {g["gig_code"]}: placed -> matched')
            advanced_oneoffs += 1
        else:
            untouched += 1

    print('\nDone.')
    print(f'  Masters reset to placed:            {reset_masters}')
    print(f'  Orphans reset to placed:            {reset_missing_assignee}')
    print(f'  One-offs advanced placed->matched:  {advanced_oneoffs}')
    print(f'  Untouched (already correct):        {untouched}')


if __name__ == '__main__':
    cleanup()
