------------------------ MODULE WritePublicationCoreMC ------------------------
EXTENDS WritePublicationCore
ModelParticipants == [t \in Txns |-> IF t = "X" THEN Owners ELSE {"A"}]
=============================================================================
