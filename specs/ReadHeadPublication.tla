-------------------------- MODULE ReadHeadPublication --------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Replicas, MaxVersion, MaxGeneration, MaxCrashes,
          GuardActivationFence, FreezeBeforePublish
ASSUME /\ Cardinality(Replicas) >= 2
       /\ "none" \notin Replicas
       /\ MaxVersion >= 2
       /\ MaxGeneration >= MaxVersion + 2 * (Cardinality(Replicas) - 1)
       /\ MaxCrashes \in Nat
       /\ GuardActivationFence \in BOOLEAN
       /\ FreezeBeforePublish \in BOOLEAN

\* Design experiment only; not a deployed protocol. The existing canonical
\* publication protocol supplies each complete, immutable, transaction-closed
\* vector. Version names such a vector; it is NOT an owner sequence number.
\* This model checks replication/freshness, not facts, leases, storage pruning,
\* data evaluation, clock bounds, throughput or unconditional availability.
\* All protocol/membership state below is durable. Crashes only remove actor
\* availability. Sending, applying and receiving an acknowledgement are separate
\* actions. An issued command may be delivered repeatedly, even in later rounds.

VARIABLE s
vars == <<s>>
Phases == {"idle", "preparing", "freezing", "activating",
           "joiningPrepare", "joiningActivate", "retiring"}
Kinds == {"prepare", "freeze", "activate", "bootstrap", "retire"}
Modes == {"standby", "serving", "frozen", "retired"}
Commands == [kind : Kinds, replica : Replicas,
             version : 0..MaxVersion, generation : 1..MaxGeneration]
InitialReplica == CHOOSE r \in Replicas : TRUE

Init == s = [
  revision |-> 0, ackedRevision |-> 0, generation |-> 0,
  pendingVersion |-> 0, phase |-> "idle", target |-> "none",
  members |-> {InitialReplica}, preparedAcks |-> {}, frozenAcks |-> {}, activeAcks |-> {},
  issued |-> {}, delivered |-> {}, rootUp |-> TRUE, crashesLeft |-> MaxCrashes,
  heads |-> [r \in Replicas |-> [
    mode |-> IF r = InitialReplica THEN "serving" ELSE "standby",
    generation |-> 0, committed |-> 0, prepared |-> 0, established |-> r = InitialReplica, up |-> TRUE]]]

TypeOK ==
  /\ s.revision \in 0..MaxVersion
  /\ s.ackedRevision \in 0..MaxVersion
  /\ s.generation \in 0..MaxGeneration
  /\ s.pendingVersion \in 0..MaxVersion
  /\ s.phase \in Phases
  /\ s.target \in Replicas \cup {"none"}
  /\ s.members \subseteq Replicas /\ s.members # {}
  /\ s.preparedAcks \subseteq Replicas
  /\ s.frozenAcks \subseteq Replicas
  /\ s.activeAcks \subseteq Replicas
  /\ s.issued \subseteq Commands /\ s.delivered \subseteq s.issued
  /\ s.rootUp \in BOOLEAN /\ s.crashesLeft \in 0..MaxCrashes
  /\ s.heads \in [Replicas -> [mode : Modes, generation : 0..MaxGeneration,
                               committed : 0..MaxVersion, prepared : 0..MaxVersion, established : BOOLEAN, up : BOOLEAN]]

\* Serving heads name the current complete publication. Frozen heads may
\* validate only projections unchanged in BOTH possible publications; every
\* other frozen/retired/unavailable case routes to canonical authority.
ServingHeadsCurrent == \A r \in Replicas :
  s.heads[r].mode = "serving" => s.heads[r].committed = s.revision
\* Immutable complete vectors alternate a single-owner change. This supplies
\* unchanged projections to check selective validation during a freeze; canonical
\* transaction closure is still an explicit upstream assumption, not re-proved.
Owners == {"A", "B"}
OwnerSequence(v, o) == IF o = "A" THEN (v + 1) \div 2 ELSE v \div 2
SameProjection(v, w, scope) == \A o \in scope : OwnerSequence(v, o) = OwnerSequence(w, o)
MayValidate(h, scope) == h.mode = "serving" \/
  (h.mode = "frozen" /\ h.established /\ SameProjection(h.committed, h.prepared, scope))
ConditionalReadsCurrent == \A r \in Replicas, scope \in (SUBSET Owners) \ {{}} :
  MayValidate(s.heads[r], scope) => SameProjection(s.heads[r].committed, s.revision, scope)
AckAfterPublication == s.ackedRevision <= s.revision
IdleAfterAck == s.phase = "idle" => s.ackedRevision = s.revision
RetiredNotMemberWhenIdle == s.phase = "idle" =>
  \A r \in s.members : s.heads[r].mode # "retired"
\* Deliberately NOT an invariant of the safe configuration: a root crash while
\* every replica is frozen can temporarily remove all latest-read routes.
CanAnswer == s.rootUp \/ (\E r \in s.members : s.heads[r].up /\ s.heads[r].mode = "serving")

Command(kind, r) == [kind |-> kind, replica |-> r,
                    version |-> s.pendingVersion, generation |-> s.generation]
Allowed(kind, r) ==
  \/ (kind = "prepare" /\ s.phase = "preparing" /\ r \in s.members)
  \/ (kind = "freeze" /\ s.phase = "freezing" /\ r \in s.members)
  \/ (kind = "activate" /\ s.phase = "activating" /\ r \in s.members)
  \/ (kind = "bootstrap" /\ s.phase = "joiningPrepare" /\ r = s.target)
  \/ (kind = "activate" /\ s.phase = "joiningActivate" /\ r = s.target)
  \/ (kind = "retire" /\ s.phase = "retiring" /\ r = s.target)

BeginPublish ==
  /\ s.rootUp /\ s.phase = "idle" /\ s.revision < MaxVersion /\ s.generation < MaxGeneration
  /\ s' = [s EXCEPT !.phase = "preparing", !.generation = @ + 1,
                    !.pendingVersion = s.revision + 1, !.target = "none",
                    !.preparedAcks = {}, !.frozenAcks = {}, !.activeAcks = {}]
BeginJoin(r) ==
  /\ s.rootUp /\ s.phase = "idle" /\ s.generation < MaxGeneration
  /\ r \notin s.members /\ s.heads[r].mode = "standby"
  /\ s' = [s EXCEPT !.phase = "joiningPrepare", !.generation = @ + 1,
                    !.pendingVersion = s.revision, !.target = r]
BeginRetire(r) ==
  /\ s.rootUp /\ s.phase = "idle" /\ s.generation < MaxGeneration
  /\ r \in s.members /\ Cardinality(s.members) > 1
  /\ s' = [s EXCEPT !.phase = "retiring", !.generation = @ + 1,
                    !.pendingVersion = s.revision, !.target = r]

Dispatch(kind, r) ==
  /\ s.rootUp /\ Allowed(kind, r) /\ Command(kind, r) \notin s.issued
  /\ s' = [s EXCEPT !.issued = @ \cup {Command(kind, r)}]

Prepared(h, c) == IF h.mode = "serving" /\ c.generation > h.generation
  THEN [h EXCEPT !.generation = c.generation, !.prepared = c.version] ELSE h
Bootstrapped(h, c) == IF h.mode = "standby" /\ c.generation > h.generation
  THEN [h EXCEPT !.generation = c.generation, !.prepared = c.version, !.mode = "frozen"] ELSE h
Frozen(h, c) == IF h.mode = "serving" /\ h.generation = c.generation
                      /\ h.prepared = c.version /\ h.committed < c.version
  THEN [h EXCEPT !.mode = "frozen"] ELSE h
Activated(h, c) == IF h.mode \in {"serving", "frozen"}
                  /\ (~GuardActivationFence \/ h.generation = c.generation)
                  /\ (h.prepared = c.version \/ h.committed = c.version)
  THEN [h EXCEPT !.mode = "serving", !.committed = c.version, !.established = TRUE] ELSE h
Retired(h, c) == IF c.generation > h.generation
  THEN [h EXCEPT !.generation = c.generation, !.mode = "retired"] ELSE h

Deliver(c) ==
  /\ c \in s.issued /\ s.heads[c.replica].up
  /\ LET h == s.heads[c.replica]
         changed == CASE c.kind = "prepare" -> Prepared(h, c)
                      [] c.kind = "bootstrap" -> Bootstrapped(h, c)
                      [] c.kind = "freeze" -> Frozen(h, c)
                      [] c.kind = "activate" -> Activated(h, c)
                      [] c.kind = "retire" -> Retired(h, c)
     IN s' = [s EXCEPT !.heads[c.replica] = changed, !.delivered = @ \cup {c}]

\* Acknowledgement can be delayed/lost independently of the durable application.
\* Current-round/phase identity rejects late replies from preceding operations.
Collect(kind, r) ==
  /\ s.rootUp /\ Allowed(kind, r) /\ Command(kind, r) \in s.delivered
  /\ CASE kind = "prepare" ->
       /\ r \notin s.preparedAcks /\ s' = [s EXCEPT !.preparedAcks = @ \cup {r}]
     [] kind = "freeze" ->
       /\ r \notin s.frozenAcks /\ s' = [s EXCEPT !.frozenAcks = @ \cup {r}]
     [] kind = "bootstrap" ->
       s' = [s EXCEPT !.members = @ \cup {r}, !.phase = "joiningActivate"]
     [] kind = "activate" ->
       IF s.phase = "joiningActivate"
         THEN s' = [s EXCEPT !.phase = "idle", !.target = "none"]
         ELSE /\ r \notin s.activeAcks /\ s' = [s EXCEPT !.activeAcks = @ \cup {r}]
     [] kind = "retire" ->
       s' = [s EXCEPT !.members = @ \ {r}, !.phase = "idle", !.target = "none"]

FinishPrepare ==
  /\ s.rootUp /\ s.phase = "preparing" /\ s.preparedAcks = s.members
  /\ s' = [s EXCEPT !.phase = "freezing"]
Publish ==
  /\ s.rootUp /\ s.phase = "freezing"
  /\ IF FreezeBeforePublish THEN s.frozenAcks = s.members ELSE s.preparedAcks = s.members
  /\ s' = [s EXCEPT !.revision = s.pendingVersion, !.phase = "activating"]
FinishPublication ==
  /\ s.rootUp /\ s.phase = "activating" /\ s.activeAcks = s.members
  /\ s' = [s EXCEPT !.ackedRevision = s.revision, !.phase = "idle"]

CrashRoot ==
  /\ s.rootUp /\ s.crashesLeft > 0
  /\ s' = [s EXCEPT !.rootUp = FALSE, !.crashesLeft = @ - 1]
RecoverRoot == /\ ~s.rootUp /\ s' = [s EXCEPT !.rootUp = TRUE]
CrashHead(r) ==
  /\ s.heads[r].up /\ s.crashesLeft > 0
  /\ s' = [s EXCEPT !.heads[r].up = FALSE, !.crashesLeft = @ - 1]
RecoverHead(r) == /\ ~s.heads[r].up /\ s' = [s EXCEPT !.heads[r].up = TRUE]

Progress ==
  \/ BeginPublish \/ FinishPrepare \/ Publish \/ FinishPublication \/ RecoverRoot
  \/ (\E r \in Replicas : BeginJoin(r) \/ BeginRetire(r) \/ RecoverHead(r))
  \/ (\E kind \in Kinds, r \in Replicas : Dispatch(kind, r) \/ Collect(kind, r))
  \/ (\E c \in s.issued : Deliver(c))
Done == s.phase = "idle" /\ s.revision = MaxVersion
        /\ s.rootUp /\ (\A r \in Replicas : s.heads[r].up)
Next == Progress \/ CrashRoot \/ (\E r \in Replicas : CrashHead(r)) \/ (Done /\ UNCHANGED s)
Spec == Init /\ [][Next]_vars /\ WF_vars(Progress)
OperationCompletes == [](s.phase # "idle" => <>(s.phase = "idle"))
AllPublicationsAcknowledged == <>(s.ackedRevision = MaxVersion)
=============================================================================
