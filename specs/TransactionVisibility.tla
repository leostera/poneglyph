-------------------------- MODULE TransactionVisibility --------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANT Shards
ASSUME Cardinality(Shards) = 2

(*--algorithm TxVisibility
variables
    phase = "preparing",
    prepared = {},
    applied = {},
    decision = "undecided",
    visibleSeq = 0,
    snapshot = 0,
    readDone = {},
    readResult = {},
    readReturned = FALSE;

define
    TypeOK ==
        /\ phase \in {"preparing", "prepared", "committing", "complete"}
        /\ prepared \subseteq Shards
        /\ applied \subseteq Shards
        /\ decision \in {"undecided", "commit"}
        /\ visibleSeq \in {0, 1}
        /\ snapshot \in {0, 1}
        /\ readDone \subseteq Shards
        /\ readResult \subseteq Shards
        /\ readReturned \in BOOLEAN

    CommitOnlyAfterEveryPrepare ==
        decision = "undecided" \/ prepared = Shards

    ApplyOnlyAfterCommitDecision ==
        decision = "commit" \/ applied = {}

    PublishedOnlyAfterAllApply ==
        visibleSeq = 0 \/ (decision = "commit" /\ applied = Shards)

    ReadIsAllOrNothing == readResult = {} \/ readResult = Shards

    ReturnedReadMatchesSnapshot ==
        readReturned => readResult = (IF snapshot = 1 THEN Shards ELSE {})
end define;

process Coordinator = "coordinator"
begin
Prepare:
    while phase = "preparing" do
        with s \in Shards \ prepared do
            prepared := prepared \cup {s};
        end with;
        if prepared = Shards then
            phase := "prepared";
        end if;
    end while;

DecideCommit:
    decision := "commit";
    phase := "committing";

ApplyParticipants:
    while applied # Shards do
        with s \in Shards \ applied do
            applied := applied \cup {s};
        end with;
    end while;

Publish:
    visibleSeq := 1;
    phase := "complete";
end process;

\* A restarted coordinator observes the durable commit decision and repeats
\* participant apply/publish. Set insertion and watermark advancement are idempotent.
process Recovery = "recovery"
begin
WaitForCommitDecision:
    await decision = "commit";

RecoverApply:
    while applied # Shards do
        with s \in Shards \ applied do
            applied := applied \cup {s};
        end with;
    end while;

RecoverPublish:
    if visibleSeq = 0 then
        visibleSeq := 1;
        phase := "complete";
    end if;
end process;

process Reader = "reader"
begin
AcquireSnapshot:
    snapshot := visibleSeq;
    readDone := {};

ReadParticipants:
    while readDone # Shards do
        with s \in Shards \ readDone do
            readDone := readDone \cup {s};
        end with;
    end while;

ReturnResult:
    readResult := IF snapshot = 1 THEN Shards ELSE {};
    readReturned := TRUE;
end process;
end algorithm;*)

====
