----------------------------- MODULE ReadHeadRouting -----------------------------
EXTENDS ReadHeadPublication
CONSTANTS GuardReadHeadAuthority, GuardCanonicalFallback
ASSUME /\ GuardReadHeadAuthority \in BOOLEAN /\ GuardCanonicalFallback \in BOOLEAN

\* Query-routing composition, not facts or lease reads. A cache version denotes
\* an already-completed, correct result for its selected projection. Arbitrary
\* stale hints may include standby/retired replicas; hints NEVER grant authority.
\* The complete canonical-vector assumption and two-owner projection abstraction
\* are inherited from ReadHeadPublication, not re-proved here.
VARIABLE q
routingVars == <<s, q>>
QueryPhases == {"idle", "probe", "fallback", "done", "failed"}
RoutingInit == Init /\
  \E hint \in SUBSET Replicas : q = [hint |-> hint, phase |-> "idle", selected |-> "none",
    scope |-> Owners, cached |-> 0, started |-> 0, answer |-> 0, linearized |-> 0,
    route |-> "none", selectedMode |-> "standby"]
BeginQuery(scope, cached, selected) ==
  /\ q.phase = "idle" /\ scope \in (SUBSET Owners) \ {{}} /\ cached \in 0..MaxVersion
  /\ IF q.hint = {} THEN selected = "none" ELSE selected \in q.hint
  /\ q' = [q EXCEPT !.phase = IF selected = "none" THEN "fallback" ELSE "probe",
                    !.scope = scope, !.cached = cached, !.selected = selected, !.started = s.revision]
  /\ UNCHANGED s
ProbeMatches == q.selected \in Replicas /\ s.heads[q.selected].up /\
  MayValidate(s.heads[q.selected], q.scope) /\ SameProjection(q.cached, s.heads[q.selected].committed, q.scope)
CompleteFromHead ==
  /\ q.phase = "probe" /\ (GuardReadHeadAuthority => ProbeMatches)
  /\ q' = [q EXCEPT !.phase = "done", !.answer = q.cached, !.linearized = s.revision,
                    !.route = "head", !.selectedMode = s.heads[q.selected].mode]
  /\ UNCHANGED s
MissHead ==
  /\ q.phase = "probe" /\ ~ProbeMatches
  /\ q' = [q EXCEPT !.phase = "fallback", !.selectedMode = s.heads[q.selected].mode]
  /\ UNCHANGED s
CompleteFromCanonical ==
  /\ q.phase = "fallback" /\ s.rootUp
  /\ q' = [q EXCEPT !.phase = "done", !.linearized = s.revision, !.route = "canonical",
                    !.answer = IF GuardCanonicalFallback THEN s.revision ELSE q.cached]
  /\ UNCHANGED s
FailClosed ==
  /\ q.phase = "fallback" /\ ~s.rootUp
  /\ q' = [q EXCEPT !.phase = "failed"] /\ UNCHANGED s
RoutingNext ==
  \/ (Next /\ UNCHANGED q)
  \/ (\E scope \in (SUBSET Owners) \ {{}}, cached \in 0..MaxVersion, selected \in Replicas \cup {"none"} :
        BeginQuery(scope, cached, selected))
  \/ CompleteFromHead \/ MissHead \/ CompleteFromCanonical \/ FailClosed
RoutingSpec == RoutingInit /\ [][RoutingNext]_routingVars
RoutingType == TypeOK /\
  q \in [hint : SUBSET Replicas, phase : QueryPhases, selected : Replicas \cup {"none"},
         scope : (SUBSET Owners) \ {{}}, cached : 0..MaxVersion, started : 0..MaxVersion,
         answer : 0..MaxVersion, linearized : 0..MaxVersion,
         route : {"none", "head", "canonical"}, selectedMode : Modes]
\* Explicit TLC-only fixture bound: one completed cache cut and an arbitrary
\* selection from the full (possibly stale/retired/standby) replica roster.
RoutingCheckBound == q.hint = Replicas /\ q.cached = 0
RoutingSafety == q.phase # "done" \/ SameProjection(q.answer, q.linearized, q.scope)
QueryLinearizesAfterStart == q.phase # "done" \/ q.linearized >= q.started
\* Reachability witnesses: these deliberately false invariants MUST fail.
NoHeadWithoutCanonical == ~(q.phase = "done" /\ q.route = "head" /\ ~s.rootUp)
NoFrozenHeadHit == ~(q.phase = "done" /\ q.route = "head" /\ q.selectedMode = "frozen")
NoRetiredHintFallback == ~(q.phase = "done" /\ q.route = "canonical" /\ q.selectedMode = "retired")
NoFailedQuery == q.phase # "failed"
=============================================================================
