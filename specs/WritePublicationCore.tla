------------------------- MODULE WritePublicationCore -------------------------
EXTENDS Naturals
CONSTANTS Owners, Txns, Participants
ASSUME ParticipantTyping == Participants \in [Txns -> (SUBSET Owners) \ {{}}]
VARIABLE s
CoreVars == <<s>>
OwnerTxns(o) == {t \in Txns : o \in Participants[t]}
CoreType == s \in [committed : SUBSET Txns, aborted : SUBSET Txns,
                       published : SUBSET Txns, acked : SUBSET Txns,
                       effects : [Owners -> SUBSET Txns],
                       visible : [Owners -> SUBSET Txns]]
CoreInv ==
  /\ CoreType
  /\ s.committed \cap s.aborted = {}
  /\ s.published \subseteq s.committed
  /\ s.acked \subseteq s.published
  /\ \A o \in Owners :
       /\ s.effects[o] \subseteq (s.committed \cap OwnerTxns(o))
       /\ s.visible[o] = (s.published \cap OwnerTxns(o))
       /\ s.visible[o] \subseteq s.effects[o]
CoreSafety ==
  /\ s.acked \subseteq s.published
  /\ \A o \in Owners : s.effects[o] \cap s.aborted = {}
  /\ \A t \in Txns :
       (\E o \in Owners : t \in s.visible[o]) =>
         /\ t \in s.committed
         /\ \A o \in Participants[t] : t \in s.visible[o] /\ t \in s.effects[o]
CoreInit == s = [committed |-> {}, aborted |-> {}, published |-> {}, acked |-> {},
                  effects |-> [o \in Owners |-> {}], visible |-> [o \in Owners |-> {}]]

\* Mixed independently decided members: rejecting R never rejects C.
\* C/R are command identities, not facts merged into one public transaction.
Decide(C, R) ==
  /\ C \subseteq Txns /\ R \subseteq Txns /\ C \cap R = {}
  /\ C \cap s.aborted = {} /\ R \cap s.committed = {}
  /\ s' = [s EXCEPT !.committed = @ \cup C, !.aborted = @ \cup R]
Apply(o, B) ==
  /\ o \in Owners /\ B \subseteq (s.committed \cap OwnerTxns(o))
  /\ s' = [s EXCEPT !.effects[o] = @ \cup B]
Publish(B) ==
  /\ B \subseteq s.committed
  /\ \A o \in Owners : (B \cap OwnerTxns(o)) \subseteq s.effects[o]
  /\ s' = [s EXCEPT !.published = @ \cup B,
                    !.visible = [o \in Owners |-> s.visible[o] \cup (B \cap OwnerTxns(o))]]
Acknowledge(B) ==
  /\ B \subseteq s.published
  /\ s' = [s EXCEPT !.acked = @ \cup B]
CoreNext ==
  \/ \E C, R \in SUBSET Txns : Decide(C, R)
  \/ \E o \in Owners, B \in SUBSET Txns : Apply(o, B)
  \/ \E B \in SUBSET Txns : Publish(B) \/ Acknowledge(B)
CoreSpec == CoreInit /\ [][CoreNext]_CoreVars

\* Sets represent unique durable effects with arbitrary immutable participant
\* sets. No numeric revision allocation, routing, prepare, predicates, queues,
\* RPC ownership, timers, physical persistence, or throughput is proved here.
=============================================================================
