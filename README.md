# Crosstalk

`crosstalk` is an OpenCode plugin that lets joined sessions message each other with a `broadcast` tool.

## Commands

- `/crosstalk join [--room ROOM] [name...]`
- `/crosstalk status`
- `/crosstalk inbox`
- `/crosstalk drop`

## Broadcast tool

- `broadcast(message="...")` updates your visible status
- `broadcast(send_to="name", message="...")` sends a direct message
- `broadcast(reply_to=1, message="...")` replies to a received message
