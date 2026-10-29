# Calorie bank — spec (v1.4.0)

Goal: keep a running tally of how far under or over the calorie target the user has been since a start
date, so they can decide themselves when to spend a surplus or cut back after an overage. The app never
changes the daily target. Off by default; switched on in Plan.

Rules (the user's):
- Each finished day with at least one diary entry adds `target − eaten` to the bank (positive = under
  target = saved; negative = over).
- A day with no entries at all resets the bank: unlogged days are usually heavy days, so the tally
  starts again from the next day. (Today is never counted; it is not finished.)
- No weekly reset. A "Reset bank" button starts the tally from today.

## 1. State (`js/store.js`)

Top-level `bank` object, deep-merged in `merge` like profile/goal (so a stored state without it gets the
defaults); backups carry it:

```js
bank: { on: false, since: null, targets: {} }
```

- `on` boolean. `since` YYYY-MM-DD: first day counted (set by Reset to today, and when first switched on to `bankStreakStart(state)`: the first day of the run of logged days ending yesterday, or today);
  null while never switched on.
- `targets`: `{ 'YYYY-MM-DD': kcal }` snapshots of the base calorie target per day, so a target that
  changes later (expenditure updates, goal edits) does not rewrite past days. `snapshotTarget(state)`
  (calc.js) writes `targets[today] = targets(state).cal` whenever called (today's value may still change
  until the day ends) and drops keys older than `since` or older than 400 days. Call it from app start
  (after `refreshExpenditure`), after `save-goal`, after `recalc`, and when the bank is switched on/reset.
  A past day without a snapshot uses today's base target.

## 2. Logic (`js/calc.js`)

```js
/** Record today's base calorie target in state.bank.targets (see state). Returns the value. Caller saves. */
export function snapshotTarget(state, date = todayStr()): number

/**
 * The bank as of `date`: the tally of finished days before `date`. null when bank.on is false or since
 * is null. Window: from bank.since up to but excluding min(date, today). Walk the days oldest first:
 *   - a day with no entries resets: balance = 0, resetDate = that day, and the days list restarts
 *     after it (the days before it are not returned);
 *   - a day with entries: target = bank.targets[day] ?? targets(state).cal, eaten = dayTotals(day).cal,
 *     diff = round(target − eaten), balance += diff.
 * Returns { balance, since: bank.since, from: <first counted day: the day after the last reset, or
 * since>, resetDate: <last unlogged day in the window or null>, days: [{ date, target, eaten, diff,
 * balance }] } where days are the counted days oldest first with the running balance; empty when nothing
 * has been counted yet.
 */
export function bankStatus(state, date = todayStr())
```

`targets(state)` and everything that uses it are unchanged.

## 3. Diary (`js/views/diary.js`)

- When `state.bank.on`, add one line under "of N kcal" in the summary card from `bankStatus(state, date)`:
  `Bank +340 kcal` (class `bank-pos`, green like the remaining number) or `Bank −200 kcal` (class `over`,
  real minus sign), `Bank 0 kcal` muted when the balance is 0 or nothing counted yet. Nothing else in the
  card changes (target, bars, remaining are the base numbers as today).

## 4. Plan (`js/views/plan.js`) — new card "Calorie bank" right after "Daily targets"

- A checkbox row "Keep a calorie bank" (`data-change="bank-toggle"`): switching on sets `since = today`
  (if null) and snapshots today's target; saves; toast "Calorie bank on". Switching off keeps `since` and
  `targets` so switching back on continues the tally; toast "Calorie bank off".
- When on, below the checkbox:
  - Summary line: `Bank +340 kcal · since Mon 27 Oct` (sign and colour as in the diary; "since <from>").
    When `resetDate` is set: a muted small note `Reset on Wed 29 Oct (no food logged)`.
  - Ledger: one row per counted day, newest first, max 60 rows: `Tue 28 · 1,820 / 2,000 · +180`
    (date short label, eaten / target, diff with sign and colour). When `days` is empty:
    `Nothing counted yet. Finished days are added the next day.`
  - Button "Reset bank" (ghost, `data-action="bank-reset"`): confirmDialog "Start the bank again from
    today?" → `since = today`, snapshot, save, toast "Bank reset". Hidden when days is empty.
- Hint: "Every finished day adds target minus eaten to the bank: under target saves calories, over
  target takes them off. A day with nothing logged resets the bank. Your targets never change; spend or
  make up the balance when you choose."

## 5. Spec, tests, versions

- `SPEC.md`: add `bank` to the state shape, `snapshotTarget`/`bankStatus` to the calc section, the Plan
  card and diary line to the views section (keep the existing style).
- `tools/test_calc.mjs` new tests, using fixed `date` arguments and a fixed `since` so they do not depend
  on the clock except where "today" matters: off or since null → null; sum of three logged days with the
  running balance; an unlogged day in the middle resets (balance only from the days after it; resetDate
  and from set; earlier days not listed); an unlogged day as the most recent finished day → balance 0,
  days empty; `date` excludes that day and today (state around `todayStr()`); snapshot per day used in
  preference to the current target (change `targets(state)` by editing goal.manual between days);
  snapshotTarget writes today and prunes keys before since; days before `since` are ignored.
- Versions (architect does these at the end): `sw.js` VERSION v9, `js/update.js` APP_VERSION 1.4.0.
