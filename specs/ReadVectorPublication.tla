-------------------------- MODULE ReadVectorPublication --------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS Owners, Txns, Mode
ASSUME
  /\ Owners = {"A", "B"}
  /\ Txns = {"T0", "T1", "T2", "T3"}
  /\ Mode \in {"naive", "gated"}

\* Design experiment, not the current Poneglyph implementation contract.
\* T0 spans A+B; T1/T3 are disjoint-entity writes on A; T2 writes B.
\* `naive` allocates owner tickets at reservation and publishes per-owner maxima;
\* `gated` waits until participant effects are ready, takes publication gates in
\* OwnerOrder, assigns each local revision as frontier+1, atomically merges the
\* complete vector at the coordinator, then releases gates and acknowledges.
\* Reader Capture copies the coordinator vector and registers one vector pin in a
\* single action; writes do not inspect or wait for that pin. This models O(1)
\* actor hops and a fixed-size vector, not an asymptotic cost proof. Crashes,
\* retries/recovery, aborts, topology changes, history pruning, and RPC uncertainty
\* remain omitted.

Max(a, b) == IF a >= b THEN a ELSE b
OwnerOrder == <<"A", "B">>

Participants ==
    [t \in Txns |->
        IF t = "T0" THEN {"A", "B"}
        ELSE IF t = "T1" THEN {"A"}
        ELSE IF t = "T2" THEN {"B"}
        ELSE {"A"}]

(*--algorithm ReadVectorPublication
variables
    frontier = [o \in Owners |-> 0],
    nextTicket = [o \in Owners |-> 0],
    phase = [t \in Txns |-> "new"],
    applied = [t \in Txns |-> {}],
    revision = [t \in Txns |-> [o \in Owners |-> 0]],
    gate = [o \in Owners |-> "free"],
    lockIndex = [t \in Txns |-> 1],
    published = {},
    acked = {},
    queryPhase = "idle",
    leaseActive = FALSE,
    queryCut = [o \in Owners |-> 0],
    snapshotPublished = {},
    snapshotAcked = {},
    scanned = {},
    seen = [o \in Owners |-> {}];

define
    TypeOK ==
        /\ frontier \in [Owners -> Nat]
        /\ nextTicket \in [Owners -> Nat]
        /\ phase \in [Txns -> {"new", "preparing", "ready", "acquiring", "finalizing", "published", "released", "acked"}]
        /\ applied \in [Txns -> SUBSET Owners]
        /\ revision \in [Txns -> [Owners -> Nat]]
        /\ gate \in [Owners -> (Txns \cup {"free"})]
        /\ lockIndex \in [Txns -> 1..(Len(OwnerOrder) + 1)]
        /\ published \subseteq Txns
        /\ acked \subseteq Txns
        /\ queryPhase \in {"idle", "captured", "done"}
        /\ leaseActive \in BOOLEAN
        /\ queryCut \in [Owners -> Nat]
        /\ snapshotPublished \subseteq Txns
        /\ snapshotAcked \subseteq Txns
        /\ scanned \subseteq Owners
        /\ seen \in [Owners -> SUBSET Txns]

    Crosses(t, v) ==
        \E o \in Participants[t] : revision[t][o] > 0 /\ revision[t][o] <= v[o]

    Covers(t, v) ==
        \A o \in Participants[t] : revision[t][o] > 0 /\ revision[t][o] <= v[o]

    Closed(v, committed) ==
        \A t \in Txns :
            Crosses(t, v) => (t \in committed /\ Covers(t, v))

    ClosedFrontier == Closed(frontier, published)

    CapturedCutClosed ==
        queryPhase = "idle"
        \/ Closed(queryCut, snapshotPublished)

    PublishedOnlyAfterAllApply ==
        \A t \in published : applied[t] = Participants[t]

    AcknowledgedOnlyAfterPublish == acked \subseteq published

    OwnerGateHasLiveOwner ==
        \A o \in Owners :
            gate[o] \in Txns =>
                /\ phase[gate[o]] \in {"acquiring", "finalizing", "published"}
                /\ o \in Participants[gate[o]]

    FinalizerOwnsEveryParticipantGate ==
        \A t \in Txns :
            phase[t] = "finalizing" =>
                \A o \in Participants[t] : gate[o] = t

    NoOverlappingFinalizers ==
        \A t1, t2 \in Txns :
            t1 # t2 /\ phase[t1] = "finalizing" /\ phase[t2] = "finalizing"
            => Participants[t1] \cap Participants[t2] = {}

    DisjointFinalizersExist ==
        \E t1, t2 \in Txns :
            t1 # t2 /\ phase[t1] = "finalizing" /\ phase[t2] = "finalizing"
            /\ Participants[t1] \cap Participants[t2] = {}

    NoDisjointFinalizers == ~DisjointFinalizersExist

    NoLeaseDuringFinalization ==
        ~(leaseActive /\ \E t \in Txns : phase[t] = "finalizing")

    LeaseRegistrationMatchesQuery ==
        /\ (queryPhase = "idle" => ~leaseActive)
        /\ (queryPhase = "captured" => leaseActive)
        /\ (queryPhase = "done" => ~leaseActive)

    CapturedAckedWritesIncluded ==
        queryPhase = "idle"
        \/ \A t \in snapshotAcked :
            /\ t \in snapshotPublished
            /\ \A o \in Participants[t] : revision[t][o] > 0 /\ revision[t][o] <= queryCut[o]

    QueryIsAtomic ==
        queryPhase # "done"
        \/ \A t \in Txns :
            (\E o \in Participants[t] : t \in seen[o])
            => \A o \in Participants[t] : t \in seen[o]
end define;

process Writer \in Txns
begin
Start:
    phase[self] := "preparing";
    if Mode = "naive" then
        revision[self] :=
            [o \in Owners |-> IF o \in Participants[self] THEN nextTicket[o] + 1 ELSE 0];
        nextTicket :=
            [o \in Owners |-> IF o \in Participants[self] THEN nextTicket[o] + 1 ELSE nextTicket[o]];
    end if;

ApplyParticipants:
    while applied[self] # Participants[self] do
        with o \in (Participants[self] \ applied[self]) do
            applied[self] := applied[self] \cup {o};
        end with;
    end while;
    phase[self] := "ready";
    if Mode = "gated" then
        lockIndex[self] := 1;
MarkAcquiring:
        phase[self] := "acquiring";
    end if;

AcquirePublicationGates:
    while Mode = "gated" /\ lockIndex[self] <= Len(OwnerOrder) do
        if OwnerOrder[lockIndex[self]] \notin Participants[self] then
            lockIndex[self] := lockIndex[self] + 1;
        else
            if gate[OwnerOrder[lockIndex[self]]] = "free" then
                gate[OwnerOrder[lockIndex[self]]] := self;
                lockIndex[self] := lockIndex[self] + 1;
            else
                skip;
            end if;
        end if;
    end while;
    if Mode = "gated" then
        revision[self] :=
            [o \in Owners |-> IF o \in Participants[self] THEN frontier[o] + 1 ELSE 0];
        phase[self] := "finalizing";
    end if;

Publish:
    if Mode = "naive" then
        frontier :=
            [o \in Owners |-> IF o \in Participants[self]
                THEN Max(frontier[o], revision[self][o])
                ELSE frontier[o]];
    else
        frontier :=
            [o \in Owners |-> IF o \in Participants[self]
                THEN revision[self][o]
                ELSE frontier[o]];
    end if;
    published := published \cup {self};
    phase[self] := "published";
    if Mode = "gated" then
        gate := [o \in Owners |-> IF gate[o] = self THEN "free" ELSE gate[o]];
MarkReleased:
        phase[self] := "released";
    end if;

Acknowledge:
    acked := acked \cup {self};
    phase[self] := "acked";
end process;

process Reader = "reader"
begin
Capture:
    queryCut := frontier;
    snapshotPublished := published;
    snapshotAcked := acked;
    leaseActive := TRUE;
    queryPhase := "captured";

ScanOwners:
    while scanned # Owners do
        with o \in (Owners \ scanned) do
            seen[o] := seen[o] \cup
                {t \in Txns : o \in Participants[t]
                    /\ revision[t][o] > 0
                    /\ revision[t][o] <= queryCut[o]};
            scanned := scanned \cup {o};
        end with;
    end while;
    leaseActive := FALSE;
    queryPhase := "done";
end process;

end algorithm;*)

FrontierNondecreasing == \A o \in Owners : frontier[o] <= frontier'[o]
FrontierMonotonic == [] [FrontierNondecreasing]_vars

================================================================================
