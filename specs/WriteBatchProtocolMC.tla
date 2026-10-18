------------------------ MODULE WriteBatchProtocolMC ------------------------
EXTENDS WriteBatchProtocol
ModelParticipants == [t \in Txns |-> IF t = "X" THEN {"A", "B"} ELSE IF t = "B1" THEN {"B"} ELSE {"A"}]
ModelMembers == [g \in Groups |-> IF g = "GX" THEN {"X"} ELSE IF g = "GA" THEN {"A1", "A2", "BAD"} ELSE {"B1"}]
ModelValid == [t \in Txns |-> t # "BAD"]
ModelTxnOrder == SelectSeq(<<"X", "A1", "A2", "BAD", "B1">>, LAMBDA t : t \in Txns)
ModelOwnerOrder == <<"A", "B">>
=============================================================================
