-- e2e-only fixture rows, layered on top of seed-schedules.sql by e2e/playwright.config.ts's
-- webServer command. These are NOT part of the app's real live-source-verified seed set
-- (scripts/ek-schedules.json / seed-schedules.sql, reconciled in Plan 10 T2) — mixing fixture
-- data into that file would misrepresent it as verified real-world schedule data. Kept here,
-- separately, so the reconciled 17-row verified set stays exactly what it claims to be.
--
-- EK9997/EK9998 (DXB<->BCN turnaround) is required by e2e/autofill.spec.ts's TURNAROUND
-- scenario. Times match the exact values the spec's comments and assertions already bake in
-- (see autofill.spec.ts's TURNAROUND doc comment). source='seed-verified' so the app's
-- cache-hit path treats it identically to a real verified row (no confirm_count=0 staleness
-- churn, no provider call) — the spec exercises the app's cache-hit + UI behavior, not the
-- live provider chain (that has its own fixture-based unit tests under
-- worker/test/schedule-providers/).
INSERT INTO flight_schedules (flight_no, leg_seq, origin, dest, dep_local, arr_local, day_offset, days_of_week, source) VALUES ('EK9997', 0, 'DXB', 'BCN', '08:20', '12:35', 0, '1234567', 'seed-verified') ON CONFLICT(flight_no, leg_seq) DO UPDATE SET origin=excluded.origin, dest=excluded.dest, dep_local=excluded.dep_local, arr_local=excluded.arr_local, day_offset=excluded.day_offset, days_of_week=excluded.days_of_week, source=excluded.source;
INSERT INTO flight_schedules (flight_no, leg_seq, origin, dest, dep_local, arr_local, day_offset, days_of_week, source) VALUES ('EK9998', 0, 'BCN', 'DXB', '14:15', '00:05', 1, '1234567', 'seed-verified') ON CONFLICT(flight_no, leg_seq) DO UPDATE SET origin=excluded.origin, dest=excluded.dest, dep_local=excluded.dep_local, arr_local=excluded.arr_local, day_offset=excluded.day_offset, days_of_week=excluded.days_of_week, source=excluded.source;

-- EK9996 (EZE->GRU->DXB) is required by e2e/board-partway.spec.ts. It mirrors EK248's real
-- shape: two legs, a day offset on each, and a landing back at base after local midnight — the
-- routing that put a whole pairing a day late when the picked date was read as leg 0's date
-- rather than as the date of the sector the crew member actually flies. GRU rather than the real
-- GIG only because GRU is in seed-airports.sql and shares its zone (America/Sao_Paulo).
INSERT INTO flight_schedules (flight_no, leg_seq, origin, dest, dep_local, arr_local, day_offset, days_of_week, source) VALUES ('EK9996', 0, 'EZE', 'GRU', '22:25', '01:10', 1, '1234567', 'seed-verified') ON CONFLICT(flight_no, leg_seq) DO UPDATE SET origin=excluded.origin, dest=excluded.dest, dep_local=excluded.dep_local, arr_local=excluded.arr_local, day_offset=excluded.day_offset, days_of_week=excluded.days_of_week, source=excluded.source;
INSERT INTO flight_schedules (flight_no, leg_seq, origin, dest, dep_local, arr_local, day_offset, days_of_week, source) VALUES ('EK9996', 1, 'GRU', 'DXB', '03:05', '00:30', 1, '1234567', 'seed-verified') ON CONFLICT(flight_no, leg_seq) DO UPDATE SET origin=excluded.origin, dest=excluded.dest, dep_local=excluded.dep_local, arr_local=excluded.arr_local, day_offset=excluded.day_offset, days_of_week=excluded.days_of_week, source=excluded.source;
