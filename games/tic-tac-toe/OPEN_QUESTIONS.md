# Open questions

Ambiguities found in `REQUIREMENTS.md`. Each has a chosen answer so work can
continue — flag any you disagree with and it changes.

## 1. Overlines — is more than the win length still a win?

"Configurable win length" does not say what happens when a player makes a run
*longer* than the win length (in gomoku some rulesets treat that as no win).

**Chosen:** an overline wins. Simpler to explain and it can only ever happen on
a move that already completed a valid line.

## 2. Invalid win length from a client

"min: 3, max 6" does not say whether an out-of-range value should be clamped or
refused.

**Chosen:** refused. `boardSizeFor` throws and the server rejects the room
request, rather than silently giving someone a different game than they asked
for.

## 3. A third person opening an invite link

"no password needed" means anyone with the link can open a room that already
has two players.

**Chosen:** they join as a read-only spectator. No cap, no chat.

## 4. Abandoned rooms

Nothing is said about cleanup.

**Chosen:** a sweep deletes rooms older than 24h that have nobody connected. A
room with a live subscriber is kept whatever its age, so a long game is never
swept out from under its players. Implemented; the TTL is injectable for tests.

## 5. Opponent disconnects

"game survives reconnection" implies waiting, but not for how long.

**Chosen:** no special handling. The 30s move timer is the only clock, so a
player who leaves mid-turn loses on time and one who leaves between turns keeps
the room alive until the 24h sweep.

## 6. Does the timer run before the second player arrives?

**Chosen:** no. The clock starts when the room reaches two players, so a host
waiting on an invite link cannot lose on time.

## 7. Who starts a rematch, and who moves first

plan.md slice 6 said a rematch should swap who moves first, but the wire only
carries a fresh state, not a fresh role — swapping seats would leave both
clients showing the wrong mark until they reloaded.

**Chosen:** seats stay put and X leads again. Either player can call the
rematch, and it is refused while a game is still in progress or if a spectator
asks. Alternating the advantage would need a role update pushed alongside the
new state.

## 8. When is a seat released?

A seat is held by its playerId for the life of the room, which is what makes a
refresh land back in the same game. The cost was that a player who left for
good still counted as present: their opponent's rematch started a clocked game
against nobody, and a friend opening the invite link became a spectator.

**Chosen:** the Leave button sends an explicit `leave` and the seat is freed.
Leaving a live game forfeits it to the opponent. A plain socket close (refresh,
lost network, closed tab) still keeps the seat, so a rematch called while the
opponent is away will start a game they can reconnect into — and lose on time
if they never do. Detecting "closed the tab for good" would need a grace
period, which is not specified.

## 9. Joining a room id that does not exist

**Chosen:** it is created, at win length 3. This keeps an invite link working
when the friend opens it first, but it also means a mistyped code silently opens
an empty room instead of reporting "no such room".

## 10. Is a room waiting on an invite link also open to random matching?

"Wait for matching randomly" and "enter a room id created by friends" are two
different doors, and a room someone made for friends should not be filled by a
stranger. But a host left waiting after a rematch in a room that random
matching opened is still, in every sense, waiting for a random opponent.

**Chosen:** rooms carry a visibility. "Create a room" and invite links make a
private room, which only the room id opens. The matchmaker makes public rooms,
and a public room that is waiting with a free seat and a connected host is
where the next random player of that win length goes — and a queued player is
seated the moment such a seat opens. Rooms saved before the flag existed load
as private.
