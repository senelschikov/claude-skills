---
name: comment-style
description: USE WHEN writing an MR description or a multi-paragraph commit body — rules for code comments, file headers, commit bodies and MR descriptions ("one fact, one home"). Applies in every repository.
allowed-tools: Read
---

# Comment style

The short form below is enough for code comments and file headers; a comment-guard deny quotes its own section. Before a commit body or an MR description, read only that section of `comment-style.md` in this skill's folder ("Commit message", "MR description"; "Placement table" says where a fact belongs). That file is the single home of the rules; do not restate them here.

Short form: at most 2 lines per fact, two facts per comment, 4 lines for a mechanism the code hides; no dates, version strings, MR numbers or "since 0.x" in code comments; expected plan and one-time ordering go to the MR description, the why and the rejected alternative to the commit body, module behaviour to the module `description`; commit body at most 5 lines, hard limit 10 non-blank.
