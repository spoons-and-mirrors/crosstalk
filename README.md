# Crosstalk

`crosstalk` is an OpenCode plugin that gives each session a paired buddy session for delegation, review, and second-opinion work.

Every session gets a `crosstalk` tool. The buddy session is created automatically the first time a session sends a crosstalk message.

## Command

- `/crosstalk` shows whether a buddy exists and how many unread messages are waiting.

## Crosstalk Tool

- `crosstalk({"action":"send","message":"..."})` creates or attaches the buddy and sends a full message.
- `crosstalk({"action":"read"})` reads full message bodies sent by the buddy.
- `crosstalk({"action":"reply","reply_to":"m1","message":"..."})` replies to a specific crosstalk message.
- `crosstalk({"action":"status"})` shows pairing status and unread counts.

Messages are persisted to a pair timeline and projected into conversation history as lightweight crosstalk markers. Full message bodies stay available through `read` rather than being forced into every model turn.
