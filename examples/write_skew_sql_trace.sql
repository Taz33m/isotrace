NAME sql_trace_write_skew_doctors
DESCRIPTION Constrained SQL trace that imports into the same explicit write-skew history model.
MODE serializable

BEGIN T0 AT 0
T0: INSERT INTO doctors (id, on_call) VALUES ('alice', true)
T0: INSERT INTO doctors (id, on_call) VALUES ('bob', true)
COMMIT T0 AT 0

BEGIN T1 AT 1 PROCESS alice
T1: SELECT id, on_call FROM doctors WHERE id = 'bob' AND on_call = true -> [{"id":"bob","on_call":true,"_from":"T0"}]
T1: UPDATE doctors SET on_call = false WHERE id = 'alice'
COMMIT T1 AT 2

BEGIN T2 AT 1.5 PROCESS bob
T2: SELECT id, on_call FROM doctors WHERE id = 'alice' AND on_call = true -> [{"id":"alice","on_call":true,"_from":"T0"}]
T2: UPDATE doctors SET on_call = false WHERE id = 'bob'
COMMIT T2 AT 3
