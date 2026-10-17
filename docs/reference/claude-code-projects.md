# Claude Code Projects reference

Frozen reference supplied by the owner on17October2026 in BRIEF.md, AppendixA. This records the surface Jevellan is to match; it is not a new independent audit of Anthropic's current service. The supplied sources are Anthropic's Claude Projects documentation and its17September2026 announcement, supplemented by community reports.

Claude Code Projects is described as a beta for Pro and Max in the browser, the desktop Code tab and the mobile app. A project has one continuing coordinator conversation. The coordinator delegates each piece of work to a thread with its own full Claude Code context. Cloud threads use their own branches and open pull requests when appropriate. Remote Control can run a thread on the owner's machine. CLI, IDE and third-party-cloud access are not included.

Quick questions are answered in the coordinator chat. New work starts a thread or goes to the existing thread working in that area, with a routing explanation. Unrelated requests in one message become separate threads, each represented by a card beneath the reply. Suggested work may appear with individual start controls and a start-all control. Owners do not manually create threads in this reference.

On a project's first run, the coordinator explores the repository and suggests setup, routines and threads. Suggestions start selected, and the owner applies the ones they want.

Project instructions contain up to16000characters and reach the coordinator and every new thread. Repository CLAUDE.md, skills, agents and commands load in each thread. Shared project memory has a MEMORY.md index; explicit remember/forget requests update it, and cloud threads read it at start. Standing preferences are remembered and followed, rather than enforced as limits. The coordinator uses recent messages, threads and memory instead of replaying its entire history.

The Overview contains Threads, Library, Pull requests and Routines. Thread groups are Ready for review; Waiting on you for questions, approvals and failures; Working; Landing for approved or queued merges; Idle; and Resolved. Resolution can be chosen by the owner or Claude after the final step, or happen automatically after one week without activity. Resolved work can reopen.

Cloud threads watch their pull requests, fix failing checks and address review comments. Conflicts need an explicit control because they produce no event. Cards offer controls to resolve conflicts, fix CI, address comments, merge, review the pull request or create one from a pushed branch. Replies on GitHub use the owner's account.

Supported threads run in auto approval mode. Any remaining approval appears in the thread and must be answered there.

Settings cover name, icon, goal, coordinator model/effort, thread model/effort with individual overrides, instructions, memory, repositories, cloud environment and plugins. The environment includes network choices, variables, secrets outside the sandbox and a setup script. Usage is available by thread, model and coordinator conversation. The supplied default is Opus low for the coordinator and Opus high for threads. Settings affect new threads. Restart, pause, archive and delete are available.

The supplied enforced limit is200new threads per day. Threads consume the plan's five-hour and weekly limits and wait automatically until reset. The prompt cache is described as lasting one hour; waking a large thread later rereads it. There is one account per project, Anthropic models only and no automatic model or effort routing.

Desktop notifications cover coordinator replies, errors and requests for owner input, with optional notifications when any thread finishes a turn. Mobile can create, steer and answer work. The Library holds uploaded files/folders and outputs, which cloud threads can read.

The reported limitations are rapid plan consumption, inability to create threads by hand, occasional hanging threads or missing coordinator reports, and context/memory tied to Anthropic's service.

Jevellan keeps its mesh, several accounts and Claude/Codex runtimes, per-thread and per-follow-up Jev placement, publication gates, terminals, shared memory and vault. This run adds the simple cards and Overview, enforced owner constraints, unattended pull request repairs and phone push while preserving those capabilities.
