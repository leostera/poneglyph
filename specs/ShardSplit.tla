------------------------------- MODULE ShardSplit -------------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Parent, Left, Right, F1, F2, F3
ASSUME Cardinality({Parent, Left, Right, F1, F2, F3}) = 6

InitialFacts == {F1, F2}
PostFacts == {F3}
AllFacts == InitialFacts \cup PostFacts
Destination ==
    [f \in AllFacts |-> IF f = F1 THEN Left ELSE IF f = F2 THEN Right ELSE Left]

(*--algorithm RecoverableSplit
variables
    splitState = "active",
    fenced = FALSE,
    epoch = 0,
    directoryMode = "parent",
    sourceData = InitialFacts,
    leftData = {},
    rightData = {},
    copied = {},
    oldLease = TRUE,
    newWrites = {},
    staleRejected = FALSE,
    staleWritesApplied = {};

define
    TypeOK ==
        /\ splitState \in {"active", "copying", "cutover", "retired"}
        /\ fenced \in BOOLEAN
        /\ epoch \in {0, 1}
        /\ directoryMode \in {"parent", "children"}
        /\ sourceData \subseteq InitialFacts
        /\ leftData \subseteq AllFacts
        /\ rightData \subseteq AllFacts
        /\ copied \subseteq InitialFacts
        /\ oldLease \in BOOLEAN
        /\ newWrites \subseteq PostFacts
        /\ staleRejected \in BOOLEAN
        /\ staleWritesApplied \subseteq PostFacts

    EpochMatchesDirectory ==
        (directoryMode = "parent" /\ epoch = 0)
        \/ (directoryMode = "children" /\ epoch = 1)

    CutoverHasCompleteCopy ==
        splitState \in {"cutover", "retired"}
        => InitialFacts \subseteq leftData \cup rightData

    RetireOnlyAfterOldReaders ==
        splitState = "retired" => ~oldLease

    FactsRemainRouted ==
        /\ \A f \in leftData : Destination[f] = Left
        /\ \A f \in rightData : Destination[f] = Right

    StaleRoutesNeverWrite == staleWritesApplied = {}
end define;

process Splitter = "splitter"
begin
BeginSplit:
    splitState := "copying";
    fenced := TRUE;

CopySnapshot:
    while copied # InitialFacts do
        with f \in InitialFacts \ copied do
            if Destination[f] = Left then
                leftData := leftData \cup {f};
            else
                rightData := rightData \cup {f};
            end if;
            copied := copied \cup {f};
        end with;
    end while;

Cutover:
    directoryMode := "children";
    epoch := 1;
    splitState := "cutover";
    fenced := FALSE;

RetireParent:
    await ~oldLease;
    sourceData := {};
    splitState := "retired";
end process;

\* Recovery replays any remaining copy pages from durable `copied` progress.
\* Set insertion makes duplicate page delivery harmless after a restart.
process Recovery = "recovery"
begin
WaitForMigration:
    while splitState = "active" do
        skip;
    end while;

ReplayMissingPages:
    if splitState = "copying" then
ReplayLoop:
        while copied # InitialFacts do
            with f \in InitialFacts \ copied do
                if Destination[f] = Left then
                    leftData := leftData \cup {f};
                else
                    rightData := rightData \cup {f};
                end if;
                copied := copied \cup {f};
            end with;
        end while;
    end if;
end process;

process OldReader = "old-reader"
begin
ReleaseLease:
    oldLease := FALSE;
end process;

process NewWriter = "new-writer"
begin
WaitForCutover:
    await splitState \in {"cutover", "retired"};

WriteAfterCutover:
    with f \in PostFacts \ newWrites do
        if epoch = 1 /\ directoryMode = "children" then
            if Destination[f] = Left then
                leftData := leftData \cup {f};
            else
                rightData := rightData \cup {f};
            end if;
            newWrites := newWrites \cup {f};
        end if;
    end with;
end process;

process StaleWriter = "stale-writer"
begin
AttemptOldRoute:
    await splitState # "active";
    if directoryMode = "parent" /\ ~fenced /\ epoch = 0 then
        staleWritesApplied := staleWritesApplied \cup {F3};
    else
        staleRejected := TRUE;
    end if;
end process;
end algorithm;*)

====
