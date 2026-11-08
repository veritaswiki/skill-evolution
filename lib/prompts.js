/**
 * 审查提示词（Review Prompts）
 *
 * **逐字移植自 Hermes `agent/background_review.py`。**
 *
 * 为什么逐字移植而不是重写：这三段文本不是普通的 prompt，它们是 Hermes 团队
 * 在真实使用中反复踩坑后沉淀下来的"什么该记、什么绝不能记、怎么写才算好技能"
 * 的完整经验编码。重写会丢掉那些用血换来的教训。
 *
 * 对应关系：
 *   _MEMORY_ROUTING_BLOCK   → MEMORY_ROUTING_BLOCK
 *   _LESSON_LAYER_BLOCK     → LESSON_LAYER_BLOCK
 *   _DO_NOT_CAPTURE_BLOCK   → DO_NOT_CAPTURE_BLOCK
 *   _SKILL_REVIEW_PROMPT    → SKILL_REVIEW_PROMPT
 *   _COMBINED_REVIEW_PROMPT → COMBINED_REVIEW_PROMPT
 *
 * 唯一改动：把 Hermes 的工具名（skill_view / skills_list / skill_manage）
 * 换成 DSH 语境下的等价描述（skill 工具 / 技能目录 / 写入草稿），
 * 把 `~/.hermes/skills/` 换成 DSH 的技能根目录。语义完全保持不变。
 */

/**
 * 记忆路由（两个库，一条事实只进一个）
 * 移植自 `_MEMORY_ROUTING_BLOCK`。
 */
export const MEMORY_ROUTING_BLOCK =
  "TWO distinct stores — pick the right one for each fact:\n" +
  "  • USER.md (memory tool, target='user'): who the user is — persona, preferences, " +
  "communication and work style, personal details they revealed, and expectations about how you " +
  "should behave.\n" +
  "  • MEMORY.md (memory tool, target='memory'): facts about the ENVIRONMENT you operate in — " +
  "tool quirks, project conventions, config gotchas, paths and endpoints that matter.\n\n" +
  "One fact goes to ONE store, never both — writing it to both bloats both files until they hit " +
  "their size limits and crowds out the facts that matter; misrouting it puts it where the next " +
  "session won't look. If the tool schema lists only one " +
  "target, that store is the only one enabled — use it and skip the other.\n\n" +
  "Save only facts GROUNDED in this conversation — a user message or tool result you can point " +
  "to. Never infer the user's traits, skill level, role, mood or preferences from topic, tone or " +
  "tools used, and never turn a one-off request into a standing preference (in either store) " +
  "unless the user marked it general ('always', 'from now on', 'remember') or stated a standing " +
  "like/dislike ('I hate X', 'stop doing Y'). If unsure, leave it " +
  "out — a wrong fact misleads every future session.\n\n";

/**
 * 教训层：什么算一个好技能
 * 移植自 `_LESSON_LAYER_BLOCK`。
 *
 * 这段文本防的是"囤积式技能库"这种失败形态：每个会话一个 references 文件、
 * 用叙事代替规则、把 PR 号当内容、重复仓库 AGENTS.md 已经教过的东西。
 */
export const LESSON_LAYER_BLOCK =
  "What a skill IS: the instructions for doing a class of task the most efficient and correct " +
  "way, to THIS user's specifications — the procedure, the tools and commands that work, the " +
  "order, the user's preferences for how the result should look, and the pitfalls that cost time. " +
  "A future session should be able to follow it and produce what the user wants on the first " +
  "try. Everything below is about writing that well:\n" +
  "  • Procedure first: the steps in the order they are done, with the concrete commands, tool " +
  "calls, and decision points. Lessons and pitfalls attach to the step they affect.\n" +
  "  • A pitfall is a generalizable rule + one clause of WHY (the mechanism), imperative. 'Grep the " +
  "test tree for the SYMBOL before widening a helper signature — hand-rolled mocks reimplement the " +
  "old shape and fail on a shard you did not run.' Not a narrative of what happened this session.\n" +
  "  • No PR/issue numbers, dates, ticket IDs, or quoted user text as content — the rule must stand " +
  "without the incident behind it. Keep a short quote ONLY when the quote itself is the clearest " +
  "statement of the rule.\n" +
  "  • The same lesson learned twice is ONE rule. Before adding, search the skill (and its " +
  "references/) for the rule already stated; strengthen or clarify it rather than appending a " +
  "second copy.\n" +
  "  • Not a duplicate of what the environment already teaches: repo AGENTS.md files, tool schema " +
  "descriptions, and other always-loaded context. A skill carries the WORKFLOW and the pitfalls; " +
  "it does not restate the codebase map or a tool's parameter list.\n" +
  "  • Always-on rules (standing user preferences, gates that apply to every instance of the " +
  "task) live in SKILL.md itself, whole. references/ is for depth that is only needed sometimes: " +
  "a decision table, a recipe, a domain note — each file topical and reusable, never " +
  "'<date>-<incident>.md'. Prefer extending an existing references/ file over creating one; " +
  "a skill with dozens of one-off references is the failure shape, not the goal.\n" +
  "  • Fix the skill in place when it is wrong: edit the sentence that misled, do not append " +
  "'UPDATE: actually...' underneath it.\n\n";

/**
 * 绝不能记什么
 * 移植自 `_DO_NOT_CAPTURE_BLOCK`。
 *
 * 这是整个机制里最重要的护栏：没有它，agent 会把自己写的
 * "X 工具不能用" 当成事实引用好几个月，即使问题早已修复。
 */
export const DO_NOT_CAPTURE_BLOCK =
  " (these become persistent self-imposed constraints that bite you later when the environment " +
  "changes):\n" +
  "  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration " +
  "path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The " +
  "user can fix these — they are not durable rules.\n" +
  "  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken', " +
  "'cannot use Y from execute_code'). These harden into refusals the agent cites against itself " +
  "for months after the actual problem was fixed.\n" +
  "  • Session-specific transient errors that resolved before the conversation ended. If " +
  "retrying worked, the lesson is the retry pattern, not the original failure.\n" +
  "  • One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is " +
  "not a class of work that warrants a skill.\n\n" +
  "  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you " +
  "tried several things, none worked, and told the user to check manually — do NOT write those " +
  "attempts up as a 'reliable workflow' or 'recommended approach'. That presents an untested " +
  "sequence of failures as validated guidance a future session will trust and repeat. Either say " +
  "'Nothing to save', or, only if you are independently confident of a real working alternative " +
  "(not something you are merely guessing might work), capture ONLY that alternative — never the " +
  "dead ends, and never dressed up as best practice.\n\n" +
  "If a tool failed because of setup state, capture the FIX (install command, config step, env " +
  "var to set) under an existing setup or troubleshooting skill — never 'this tool does not " +
  "work' as a standalone constraint.\n\n";

/**
 * 技能审查提示词（主模板）
 * 移植自 `_SKILL_REVIEW_PROMPT`。
 *
 * 关键设计：
 *   - 开篇就反对惰性："Be ACTIVE — 空过是失败，不是中立结果"
 *   - 明确目标形态：类级别技能（CLASS-LEVEL），不是一次性窄技能
 *   - 四级优先顺序：改已加载的 > 改已有伞 > 加支撑文件 > 新建
 *   - Read-before-write 强制
 *   - 用户偏好嵌入技能而非记忆
 */
export const SKILL_REVIEW_PROMPT =
  "Review the conversation above and update the skill library. Be ACTIVE — most sessions produce " +
  "at least one skill update, even if small. A pass that does nothing is a missed learning " +
  "opportunity, not a neutral outcome.\n\n" +
  "Target shape of the library: CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a " +
  "small `references/` set of topical depth. Not a flat list of narrow one-session skills, and " +
  "not an umbrella hoarding a references/ file per session. This shapes HOW you update, not " +
  "WHETHER you update.\n\n" +
  LESSON_LAYER_BLOCK +
  "Signals to look for (any one of these warrants action):\n" +
  "  • User corrected your style, tone, format, legibility, or verbosity. Frustration signals " +
  "like 'stop doing X', 'this is too verbose', 'don't format like this', 'why are you " +
  "explaining', 'just give me the answer', 'you always do Y and I hate it', or an explicit " +
  "'remember this' are FIRST-CLASS skill signals, not just memory signals. Update the relevant " +
  "skill(s) to embed the preference so the next session starts already knowing.\n" +
  "  • User corrected your workflow, approach, or sequence of steps. Encode the correction as a " +
  "pitfall or explicit step in the skill that governs that class of task.\n" +
  "  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged " +
  "that a future session would benefit from. Capture it.\n" +
  "  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, " +
  "or outdated. Patch it NOW.\n\n" +
  "Preference order — prefer the earliest action that fits, but do pick one when a signal above " +
  "fired:\n" +
  "  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation for skills the user " +
  "loaded via /skill-name or you read via the skill tool. If any of them covers the territory of " +
  "the new learning, PATCH that one first (re-load it with the skill tool during this review — " +
  "see Read-before-write below). It is the skill that was in play, so it's the right one to " +
  "extend — whoever wrote it: hand-written, installed, bundled, and pinned skills are all yours " +
  "to improve. The one exception is a skill the user LOCKED: the write is refused — do not " +
  "retry and do not recreate it under another name; put the suggested " +
  "change in your summary instead.\n" +
  "  2. UPDATE AN EXISTING UMBRELLA (via the skill catalog + the skill tool). If no loaded skill " +
  "fits but an existing class-level skill does, patch it. Add a subsection, a pitfall, or " +
  "broaden a trigger.\n" +
  "  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be packaged with three kinds " +
  "of support files — use the right directory per kind:\n" +
  "     • `references/<topic>.md` — topical depth needed only sometimes: a decision table, a " +
  "reproduction recipe, provider quirks, condensed domain notes or API excerpts. Name it by " +
  "TOPIC and extend an existing file when one covers the topic; do not create a per-session or " +
  "per-incident file, and do not paste error transcripts — distill them to the rule.\n" +
  "     • `templates/<name>.<ext>` — starter files meant to be copied and modified (boilerplate " +
  "configs, scaffolding, a known-good example the agent can `reproduce with modifications`).\n" +
  "     • `scripts/<name>.<ext>` — statically re-runnable actions the skill can invoke directly " +
  "(verification scripts, fixture generators, deterministic probes, anything the agent should " +
  "run rather than hand-type each time).\n" +
  "     The umbrella's SKILL.md should gain a one-line pointer to any new support file so future " +
  "agents know it exists.\n" +
  "  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing skill covers the class. The " +
  "name MUST be at the class level. The name MUST NOT be a specific PR number, error string, " +
  "feature codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' session artifact. " +
  "If the proposed name only makes sense for today's task, it's wrong — fall back to (1), (2), " +
  "or (3).\n\n" +
  "Read-before-write (ENFORCED — the write is refused otherwise): before you patch or edit an " +
  "existing skill's SKILL.md, load that skill with the skill tool during this review. Before " +
  "you overwrite or remove an EXISTING supporting file, load that exact file. Content quoted " +
  "earlier in the conversation transcript does NOT count — the " +
  "guard requires a fresh load within this review, and your write must be based on what " +
  "the skill tool just returned. Creating a brand-new skill or adding a NEW supporting file " +
  "needs no prior read. If a write is refused with a read-before-write error, load the " +
  "named target once and retry the write once; do not loop.\n\n" +
  "User-preference embedding (important): when the user expressed a style/format/workflow " +
  "preference, the update belongs in the SKILL.md body, not just in memory. Memory captures 'who " +
  "the user is and what the current situation and state of your operations are'; skills capture " +
  "'how to do this class of task for this user'. When they complain about how you handled a " +
  "task, the skill that governs that task needs to carry the lesson.\n\n" +
  "If you notice two existing skills that overlap, note it in your reply — the background " +
  "curator handles consolidation at scale. Never delete a skill here.\n\n" +
  "Do NOT capture" +
  DO_NOT_CAPTURE_BLOCK +
  "'Nothing to save.' is a real option but should NOT be the default. If the session ran " +
  "smoothly with no corrections and produced no new technique, just say 'Nothing to save.' and " +
  "stop. Otherwise, act.";

/**
 * 组合审查提示词（记忆 + 技能一次搞定）
 * 移植自 `_COMBINED_REVIEW_PROMPT`。
 */
export const COMBINED_REVIEW_PROMPT =
  "Review the conversation above and update two things:\n\n" +
  "**Memory**: " +
  MEMORY_ROUTING_BLOCK +
  "**Skills**: how to do this class of task. Be ACTIVE — most sessions produce at least one " +
  "skill update. A pass that does nothing is a missed learning opportunity, not a neutral " +
  "outcome.\n\n" +
  "Target shape of the skill library: CLASS-LEVEL skills with a SKILL.md of always-on rules and a " +
  "small `references/` set of topical depth — not narrow one-session skills, and not an umbrella " +
  "hoarding a references/ file per session.\n\n" +
  LESSON_LAYER_BLOCK +
  "Signals that warrant a skill update (any one is enough):\n" +
  "  • User corrected your style, tone, format, legibility, verbosity, or approach. Frustration " +
  "is a FIRST-CLASS skill signal, not just a memory signal. 'stop doing X', 'don't format like " +
  "this', 'I hate when you Y' — embed the lesson in the skill that governs that task so the next " +
  "session starts fixed.\n" +
  "  • Non-trivial technique, fix, workaround, or debugging path emerged.\n" +
  "  • A skill that was loaded or consulted turned out wrong, missing, or outdated — patch it " +
  "now.\n\n" +
  "Preference order for skills — pick the earliest that fits:\n" +
  "  1. UPDATE A CURRENTLY-LOADED SKILL. Check what skills were loaded via /skill-name or " +
  "the skill tool in the conversation. If one of them covers the learning, PATCH it first " +
  "(re-load it during this review — see Read-before-write below). It was in play; it's the " +
  "right place, whoever wrote it.\n" +
  "  2. UPDATE AN EXISTING UMBRELLA (skill catalog + skill tool to find the right one). Patch it.\n" +
  "  3. ADD A SUPPORT FILE under an existing umbrella. Three " +
  "kinds: `references/<topic>.md` for topical depth (decision tables, recipes, quirks, condensed " +
  "domain notes) — extend an existing topical file before creating one, never a per-session file; " +
  "`templates/<name>.<ext>` for starter files meant to be copied and modified; " +
  "`scripts/<name>.<ext>` for statically re-runnable actions (verification, fixture generators, " +
  "probes). Add a one-line pointer in SKILL.md so future agents find them.\n" +
  "  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists. Name at the class level — NOT a " +
  "PR number, error string, codename, library-alone name, or 'fix-X / debug-Y' session artifact. " +
  "If the name only fits today's task, fall back to (1), (2), or (3).\n\n" +
  "Read-before-write (ENFORCED — the write is refused otherwise): before patching or editing an " +
  "existing skill's SKILL.md, load it with the skill tool during this review; before " +
  "overwriting or removing an EXISTING supporting file, load that exact " +
  "file. Content quoted earlier in the transcript does NOT count — base the write on what " +
  "the skill tool just returned. New skills and NEW supporting files need no prior read. On a " +
  "read-before-write refusal: load the named target once, retry the write once, do not loop.\n\n" +
  "User-preference embedding: when the user complains about how you handled a task, update the " +
  "skill that governs that task rather than memory. Memory says 'who the user is and " +
  "what the current situation and state of your operations are'; skills say 'how to do this " +
  "class of task for this user'. A user-preference lesson lives in exactly ONE place: the skill " +
  "that governs the task when one exists, USER.md only for cross-cutting preferences no skill " +
  "owns — never both. Duplicating it is how a memory file ends up restating SKILL.md until both " +
  "hit their size limits.\n\n" +
  "If you notice overlapping existing skills, mention it — the background curator handles " +
  "consolidation. Never delete a skill here.\n\n" +
  "Do NOT capture as skills" +
  DO_NOT_CAPTURE_BLOCK +
  "Act on whichever of the two dimensions has real signal. If genuinely nothing stands out on " +
  "either, say 'Nothing to save.' and stop — but don't reach for that conclusion as a default.";

/**
 * DSH 特有的输出契约（Hermes 没有这一段，因为 Hermes 直接调工具写入；
 * DSH 的复盘 fork 是只读的，必须输出结构化 JSON 交给 Synthesizer 落盘）。
 *
 * 这段必须放在提示词最后，确保模型在理解完所有规则后再看输出格式。
 */
export const OUTPUT_CONTRACT = `

---

## Output contract (DSH-specific — overrides the tool-calling instructions above)

You are a READ-ONLY review fork. You cannot write files. Instead, output ONE fenced JSON block
and nothing else after it. The harness will apply it under a gate.

Follow the exact Hermes skill-writing rules for \`frontmatter\` and \`body\`.
In addition, provide a \`briefing\` object in Simplified Chinese (简体中文) so the visual UI can render a clear
decision simulation for the user.

\`\`\`json
{
  "action": "create" | "patch" | "add_reference" | "nothing",
  "target": "<kebab-case skill name>",
  "filePath": "<only for add_reference, e.g. references/decision-table.md>",
  "frontmatter": { "name": "<same as target>", "description": "<concise trigger & capability description>" },
  "body": "<Full Markdown body for create, or the COMPLETE new body for patch>",
  "rationale": "<one or two sentences: which signal fired and why this action>",
  "briefing": {
    "titleZh": "<简短中文标题>",
    "triggerZh": "<一句话中文触发场景>",
    "whatItIs": "<一句话中文说明这个技能的核心经验>",
    "ifApprove": "<中文说明：如果同意，系统会如何生效>",
    "ifReject": "<中文说明：如果驳回，会发生什么>"
  },
  "signals": ["user-correction" | "new-technique" | "skill-was-wrong" | "workflow-correction"],
  "confidence": "high" | "medium" | "low"
}
\`\`\`

Rules for the JSON:
- \`action: "nothing"\` with \`target: ""\` is valid ONLY when no signal fired at all.
- For \`patch\`, \`body\` must be the ENTIRE new SKILL.md body (frontmatter excluded) — the harness
  replaces the body wholesale. Preserve everything still true; fix only what the lesson touches.
- Never invent a skill name that is a session artifact (see rule 4 above).
- \`confidence: "low"\` means the harness will stage it for human review instead of applying it.`;

/** 组装最终复盘提示词。 */
export function buildReviewPrompt({ includeMemory = false } = {}) {
  const base = includeMemory ? COMBINED_REVIEW_PROMPT : SKILL_REVIEW_PROMPT;
  return base + OUTPUT_CONTRACT;
}

/**
 * Curator 合并提示词（建伞 pass）
 *
 * **逐字移植自 Hermes `agent/curator.py` 的 `CURATOR_REVIEW_PROMPT`。**
 *
 * 这是 curator 的 LLM 部分——把一堆窄技能合并成类级别的"伞"。
 * Hermes 的原文强调：几百个各捕获一次会话 bug 的窄技能是**失败**，不是特性。
 *
 * 替换：`skill_view`/`skills_list`/`skill_manage` → DSH 的 `skill` 工具与插件写入路径；
 * `~/.hermes/skills/.archive/` → DSH 的 `.archive/`；`hermes curator rollback` → `/evolution rollback`。
 */
export const CURATOR_REVIEW_PROMPT =
  "You are running as DSH's background skill CURATOR. This is an " +
  "UMBRELLA-BUILDING consolidation pass, not a passive audit and not a " +
  "duplicate-finder.\n\n" +
  "The goal of the skill collection is a LIBRARY OF CLASS-LEVEL " +
  "INSTRUCTIONS AND EXPERIENTIAL KNOWLEDGE. A collection of hundreds of " +
  "narrow skills where each one captures one session's specific bug is " +
  "a FAILURE of the library — not a feature. An agent searching skills " +
  "matches on descriptions, not on exact names (note: the system prompt " +
  "skill index shows 60 chars of a description — keep the trigger class " +
  "in that window). One broad umbrella " +
  "skill with labeled subsections beats five narrow siblings for " +
  "discoverability, not the other way around.\n\n" +
  "The right target shape is CLASS-LEVEL skills whose SKILL.md carries the " +
  "always-on rules and whose `references/`, `templates/`, and `scripts/` hold a " +
  "SMALL set of topical depth — not one-session-one-skill micro-entries, and " +
  "not an umbrella that hoards one references/ file per absorbed sibling. " +
  "Consolidation means DISTILLING: the absorbed content becomes rules " +
  "(imperative + one clause of why), the same lesson stated twice becomes " +
  "one rule, and incident narration, PR/issue numbers, dates and quoted " +
  "chatter are dropped — the rule must stand without the story. Moving a " +
  "file unchanged under references/ is filing, not consolidating. A SKILL.md " +
  "body over ~24k chars is a consolidation target on its own: loading it " +
  "pulls all of it into context for the rest of the session, so distill it to " +
  "the always-on rules and push topic depth into references/.\n\n" +
  "Hard rules — do not violate:\n" +
  "1. DO NOT touch bundled, hub-installed, or external-dir skills. The " +
  "candidate list below is already filtered to local curator-managed skills " +
  "only; external skills are externally owned and read-only to this curator.\n" +
  "2. DO NOT delete any skill. Archiving (moving the skill's directory " +
  "into the skills root's `.archive/`) is the maximum destructive action. " +
  "Archives are recoverable; deletion is not.\n" +
  "3. DO NOT touch skills shown as pinned=yes. Skip them entirely.\n" +
  "3b. DO NOT archive, delete, consolidate, move, or otherwise modify any " +
  "skill named in the protected built-ins list. These back load-bearing UX " +
  "and are filtered out of the candidate list below — never resurrect " +
  "one as an archive or absorb target.\n" +
  "4. DO NOT use usage counters as a reason to skip consolidation. The " +
  "counters are new and often mostly zero. Judge overlap on CONTENT, " +
  "not on use_count. 'use=0' is not evidence a skill is valuable; it's " +
  "absence of evidence either way. Corollary: 'use=0' is ALSO not a " +
  "reason to PRUNE a skill. Never archive a never-used skill (use=0) " +
  "unless it is at least 30 days old (check last_activity / created date) " +
  "AND its content is genuinely obsolete or fully absorbed elsewhere — a " +
  "recently-created skill simply may not have had its trigger come up yet.\n" +
  "5. DO NOT reject consolidation on the grounds that 'each skill has " +
  "a distinct trigger'. Pairwise distinctness is the wrong bar. The " +
  "right bar is: 'would a human maintainer write this as N separate " +
  "skills, or as one skill with N labeled subsections?' When the " +
  "answer is the latter, merge.\n\n" +
  "How to work — not optional:\n" +
  "1. Scan the full candidate list. Identify PREFIX CLUSTERS (skills " +
  "sharing a first word or domain keyword). Expect 10-25 clusters.\n" +
  "2. For each cluster with 2+ members, do NOT ask 'are these pairs " +
  "overlapping?' — ask 'what is the UMBRELLA CLASS these skills all " +
  "serve? Would a maintainer name that class and write one skill for " +
  "it?' If yes, pick (or create) the umbrella and absorb the siblings " +
  "into it.\n" +
  "3. Three ways to consolidate — use the right one per cluster:\n" +
  "   a. MERGE INTO EXISTING UMBRELLA — one skill in the cluster is " +
  "already broad enough to be the umbrella. Patch it to add a labeled " +
  "section for each sibling's unique insight, then archive the " +
  "siblings.\n" +
  "   b. CREATE A NEW UMBRELLA SKILL.md — no existing member is broad " +
  "enough. Create a new class-level " +
  "skill whose SKILL.md covers the shared workflow and has short " +
  "labeled subsections. Archive the now-absorbed narrow siblings.\n" +
  "   c. DEMOTE TO REFERENCES/TEMPLATES/SCRIPTS — a sibling has " +
  "narrow-but-valuable depth that is only needed sometimes. Distill it " +
  "into the umbrella's appropriate support directory:\n" +
  "      • `references/<topic>.md` — named by TOPIC, merged into an " +
  "existing topical file when one covers it (decision tables, recipes, " +
  "provider quirks, condensed domain notes). Never `<sibling-name>.md` " +
  "copied verbatim; never a per-incident file.\n" +
  "      • `templates/<name>.<ext>` for starter files meant to be " +
  "copied and modified\n" +
  "      • `scripts/<name>.<ext>` for statically re-runnable actions " +
  "(verification scripts, fixture generators, probes)\n" +
  "      Then archive the old sibling. Re-home the content through the " +
  "LEDGERED write path so it is rollback-able — never a shell mv/cp, " +
  "which writes the same bytes with no ledger entry, so the archive that " +
  "follows snapshots an already-stripped package and rollback restores a " +
  "hollow skill.\n\n" +
  "Package integrity — not optional:\n" +
  "Before demoting or archiving a skill, inspect it as a COMPLETE " +
  "directory package, not just SKILL.md. A skill root may include " +
  "`references/`, `templates/`, `scripts/`, and `assets/`; the skill " +
  "loader discovers those relative to the skill root. A reference markdown " +
  "file inside another skill is NOT a new skill root and does not get its own " +
  "linked-file discovery.\n" +
  "If the source skill has support files OR SKILL.md contains relative " +
  "links such as `references/...`, `templates/...`, `scripts/...`, or " +
  "`assets/...`, DO NOT flatten only SKILL.md into " +
  "`<umbrella>/references/<old>.md`. Choose one safe path instead:\n" +
  "   • keep it as a standalone skill, OR\n" +
  "   • fully merge it by re-homing every needed support file into the " +
  "umbrella's canonical `references/`, `templates/`, `scripts/`, or " +
  "`assets/` directories AND rewrite the destination instructions to " +
  "the new paths, OR\n" +
  "   • archive the entire original skill package unchanged.\n" +
  "Never leave archived/demoted instructions pointing at files that were " +
  "left behind under the old skill directory.\n" +
  "4. Also flag skills whose NAME is too narrow (contains a PR number, " +
  "a feature codename, a specific error string, an 'audit' / " +
  "'diagnosis' / 'salvage' session artifact). These almost always " +
  "belong as a subsection or support file under a class-level umbrella.\n" +
  "5. Iterate. After one consolidation round, scan the remaining set " +
  "and look for the NEXT umbrella opportunity. Don't stop after 3 " +
  "merges.\n\n" +
  "Your toolset:\n" +
  "  - the skill tool                — read the current landscape\n" +
  "    READ BEFORE WRITE — enforced, not advisory. Before patching, " +
  "overwriting an existing support file, or removing a file, load that " +
  "SAME target in this review turn and build the write from the content " +
  "it just returned. A write without that read is REFUSED.\n" +
  "  - action=patch      — add sections to the umbrella\n" +
  "  - action=create     — create a new umbrella SKILL.md\n" +
  "  - action=write_file — add a references/, templates/, " +
  "or scripts/ file under an existing skill (the skill must already " +
  "exist)\n" +
  "  - action=archive    — archive a skill. MUST name `absorbed_into=<umbrella>` " +
  "naming the skill you merged its content " +
  "into (the umbrella must already exist). Archives without a verified " +
  "forwarding target are refused — pruning with no absorption target is " +
  "the deterministic staleness pass's job, never this one's.\n" +
  "  You have NO terminal access in this pass — every filesystem mutation " +
  "goes through the ledgered write path above so it is rollback-able.\n\n" +
  "'keep' is a legitimate decision ONLY when the skill is already a " +
  "class-level umbrella and none of the proposed merges would improve " +
  "discoverability. 'This is narrow but distinct from its siblings' " +
  "is NOT a reason to keep — it's a reason to move it under an " +
  "umbrella as a subsection or support file.\n\n" +
  "Expected output: real umbrella-ification. Process every obvious " +
  "cluster.\n\n" +
  "When done, write a human summary AND a structured machine-readable " +
  "block so downstream tooling can distinguish consolidation from " +
  "pruning. Format EXACTLY:\n\n" +
  "## Structured summary (required)\n" +
  "```yaml\n" +
  "consolidations:\n" +
  "  - from: <old-skill-name>\n" +
  "    into: <umbrella-skill-name>\n" +
  "    reason: <one short sentence — why merged, not just 'similar'>\n" +
  "prunings:\n" +
  "  - name: <skill-name>\n" +
  "    reason: <one short sentence — why archived with no merge target>\n" +
  "```\n\n" +
  "Every skill you moved to `.archive/` MUST appear in exactly one of the " +
  "two lists. If you consolidated X into umbrella Y (patched Y, wrote " +
  "a references file to Y, or created Y with X's content absorbed), X " +
  "goes under `consolidations` with `into: Y`. If you archived X with " +
  "no absorption — truly stale, irrelevant, or obsolete — X goes under " +
  "`prunings`. Leave a list empty (`consolidations: []`) if none. Do " +
  "not omit the block. The block comes AFTER your human-readable " +
  "summary of clusters processed, patches made, and decisions left alone.";

/** Curator 合并的输出契约（DSH 特有：fork 只读，输出 JSON 由插件执行）。 */
export const CURATOR_OUTPUT_CONTRACT = `

---

## Output contract (DSH-specific)

You are a READ-ONLY curator fork. You cannot write files. Output ONE fenced JSON block:

\`\`\`json
{
  "operations": [
    { "op": "patch", "target": "<umbrella>", "body": "<complete new SKILL.md body>" },
    { "op": "create", "target": "<new-umbrella>", "frontmatter": { "name": "...", "description": "..." }, "body": "..." },
    { "op": "write_file", "target": "<umbrella>", "filePath": "references/<topic>.md", "body": "..." },
    { "op": "archive", "target": "<sibling>", "absorbedInto": "<umbrella>", "reason": "..." }
  ],
  "summary": "<one paragraph: clusters processed, what merged where>"
}
\`\`\`

Rules:
- Every \`archive\` MUST name \`absorbedInto\` pointing at a skill that exists or is created in this same block.
- Never archive a pinned or protected skill.
- If nothing should change, output \`{"operations": [], "summary": "..."}\`.`;

/** 组装 curator 合并提示词。 */
export function buildCuratorPrompt({ candidates = [], protectedNames = [] } = {}) {
  const list = candidates.length
    ? candidates
        .map((s) => {
          const header = `- ${s.name} (use=${s.useCount ?? 0}, state=${s.state ?? "active"}${s.pinned ? ", pinned=yes" : ""}): ${s.description || "(no description)"}`;
          const excerpt = s.body ? `\n  \`\`\`markdown\n  ${String(s.body).trim().replace(/\n/g, "\n  ")}\n  \`\`\`` : "";
          return header + excerpt;
        })
        .join("\n\n")
    : "(no curator-managed skills yet)";
  return (
    CURATOR_REVIEW_PROMPT +
    `\n\n## Candidate list (already filtered)\n\n${list}\n` +
    (protectedNames.length ? `\nProtected built-ins (never touch): ${protectedNames.join(", ")}\n` : "") +
    CURATOR_OUTPUT_CONTRACT
  );
}
