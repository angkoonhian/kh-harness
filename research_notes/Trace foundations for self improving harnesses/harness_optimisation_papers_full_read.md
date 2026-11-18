# Harness-optimisation papers, full read (2025 to November 2026)

Research date: 2026-11-18. This round read paper bodies and appendices; it corrects and deepens the first-round notes in `Self improving agents and harnesses/agent_self_improvement_science.md` and does not repeat what those notes already established from a full read (GSME's body, HGM's main tables, ACE's main tables).

Read-depth tags used below:
- **[body]**: the figure or statement was read from the paper's HTML or PDF body or appendix in this session. arXiv HTML pages are long; the reader covered the first ~100,000 characters of each unless a second pass is noted, so late appendices are often missing and are listed under Gaps.
- **[abstract]**: only the abstract page was read.
- **[snippet]**: seen only in a search-result summary or secondary write-up; not verified against the primary source.

Corrections to first-round notes are marked **Correction**.

## 1. For each system: the full loop, proposer inputs, evaluation protocol, results, cost and stated limitations

### Takeaway
Every system is the same five-part machine (editable artefact, LLM proposer, executable evaluator, store of past candidates, selection rule) and the papers differ mainly in what the proposer is shown and how a candidate is admitted. Read in full, the headline numbers are weaker than the abstracts suggest: several compare the starting point with the best iteration rather than the last (SICA), search and report on the same tasks (Meta-Harness on TerminalBench-2, AHE, HarnessX), or start from a baseline that scores 0.0 for interface reasons (Hyperagents).

### Cited Findings

**Meta-Harness** (Lee, Nair, Zhang, Lee, Khattab, Finn; arXiv 2603.28052 v1, 30 March 2026) [body, both halves]
- Editable surface: one single-file Python harness per candidate (prompting, retrieval, memory, orchestration). Proposer: Claude Code with Opus 4.6, steered by a short domain "skill" that says where to write, how to inspect prior candidates, and what it may modify — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Proposer inputs: a filesystem holding, for every evaluated harness, source, scores and raw execution traces (prompts, tool calls, model outputs, state updates), browsed with grep and cat. In the TerminalBench-2 run it read a median of 82 files per iteration (range 69–99): about 41% source, 40% traces, 6% scores or summaries, 13% other, and referenced over 20 prior candidates per step. About 10 MTok of context per iteration versus 0.002–0.026 MTok for other optimisers — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Loop: k candidates per iteration; an interface-validity check before evaluation; no parent-selection rule (the proposer may build on any prior harness); a Pareto frontier is tracked; fixed iteration count; the frontier is then scored on the test set, which the proposer never sees. Iterations: 20 for text classification (two candidates each), 40 for maths retrieval (109 candidates), 10 in the TerminalBench-2 log — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Internal inconsistency: a "typical run" is described as about 60 harnesses over 20 iterations, but the text-classification run is 40 candidates; Table 2 gives the winning harness 11.4K context tokens while Table 9 lists 45.5 for the same variant in different units — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Results, text classification with GPT-OSS-120B (test): Meta-Harness 48.6 average versus ACE 40.9, MCE 40.0, few-shot 40.8, zero-shot 27.4. Search-set comparison of optimisers (median / best): GEPA 32.6 / 40.2, Best-of-N 34.0 / 44.2, OpenEvolve 39.1 / 43.3, TTT-Discover 34.1 / 45.6, Meta-Harness 50.0 / 56.7. Nine out-of-distribution datasets: 73.1 versus ACE 70.2 — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Results, maths retrieval (200 IMO-level problems, pass@1 over 3 samples, 5-model average): no retriever 34.1, BM25 37.5, dense k=5 38.1, Meta-Harness 38.8, so +1.3 over BM25 — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Results, TerminalBench-2 (89 tasks): Opus 4.6: Meta-Harness 76.4, ForgeCode 81.8 (the authors could not reproduce it from public code), Capy 75.3, Terminus-KIRA 74.7, Terminus 2 62.9, Claude Code 58.0. Haiku 4.5: Meta-Harness 37.6, Goose 35.5, Terminus-KIRA 33.7 — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Internal inconsistency: the Appendix A search log cites a 64.4% Terminus-KIRA baseline against which iterations are scored, not the 74.7% leaderboard figure — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- **Correction (resolves the "five held-out models" flag):** the body tests five models, of which four were unseen during search (GPT-5.4-nano, GPT-5.4-mini, Gemini-3.1-Flash-Lite, Gemini-3-Flash); GPT-OSS-20B was used to select the harness, so only four are truly held out — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Cost: "a few hours" of wall-clock per search run; no dollar or total-token figure is given — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Limitations: TerminalBench-2 search and final evaluation use the same 89 tasks with no split (leakage checked only by manual inspection and regex audits); only one proposer agent was studied — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Appendix D, the authors' implementation advice: the skill text is the main lever ("iterating on the skill text had a larger effect on search quality than changing iteration count or population size"); debug it with 3–5 short runs; the skill should fix forbidden actions, required artefacts and objectives but not the diagnosis procedure; build the search set from examples a simple baseline gets wrong, small enough for about 50 full evaluations (50–100 examples); log code, scores and traces as hierarchical JSON with regex-friendly names; optionally add a small CLI to list the frontier, show top-k and diff runs; reject candidates in seconds with an import-and-smoke test; run evaluation outside the proposer — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)

**Darwin Gödel Machine** (Zhang, Hu, Lu, Lange, Clune; arXiv 2505.22954 v2; ICLR 2026) [body and appendices to ~200K characters]
- Editable surface: the agent's own Python repository. Initial agent: a bash tool and a whole-file edit tool, one prompt with repo location, problem statement and test framework. Archive maintenance and parent selection are fixed — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Parent selection (Appendix C.2): eligible if score α_i < 1; s_i = 1/(1+exp(−10(α_i − 0.5))); h_i = 1/(1+n_i) with n_i the number of functioning children; weight s_i·h_i, normalised; k = 2 parents per iteration on SWE-bench, 4 on Polyglot, drawn with replacement — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Proposer inputs (Appendix C.3): a separate model, OpenAI o1, diagnoses. It is given the agent's code summary and implementation, the agent's running log on a task, the GitHub issue, the predicted patch, **SWE-bench's private test patch**, and the test results, and returns one improvement plan as JSON; that plan becomes the problem statement the parent agent (Claude 3.5 Sonnet New) implements on itself. The authors report no observed memorisation of private tests, on manual inspection only — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Evaluation: 10-task sanity check; 60-task subset; 200 tasks only for agents above 40% that rank in the archive's top two. Polyglot: 10 then 50. Admission: must compile and still be able to edit code. 80 iterations, fixed — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Results and ablations (Table 1): DGM 50.0% SWE-bench / 38.0% Polyglot-50; without self-improvement 39.0% / 28.0%; without open-ended exploration (archive keeps only the latest agent) 23.0% / 14.0%; "DGM Greedy" 39.7% / 30.0%. Base agent 20.0% / 14.0% — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Reference point: OpenHands + CodeAct v2.1 with the same Claude 3.5 Sonnet scored 53.0% on SWE-bench Verified and 51.0% on DGM's 200-task subset, so the evolved agent (50.0%) is about level with, not above, the best open hand-built agent of the time — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Polyglot model transfer (Appendix A.2) is small: Claude 3.5 Sonnet 32.0% to 33.3%, Claude 3.7 Sonnet 35.6% to 36.8% — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Variance: three Polyglot runs, mean 40.7%, standard deviation 2.3%; no repeat count for SWE-bench — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Cost (Appendix E.1): about USD 22,000 for one SWE-bench run and about USD 10,000 per ablation run; one 60-task evaluation about $350 with Claude 3.5 Sonnet; about two weeks wall-clock. **This confirms from the primary source the $22,000 figure the first round had only second-hand** — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Limitations: cost; ceiling set by the frozen model; assumes benchmark score tracks self-improvement ability; the open-ended process itself is fixed — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)

**Huxley-Gödel Machine** (Wang et al.; arXiv 2510.21614 v3; ICLR 2026 oral) [body; appendix partly]
- Loop additions beyond the first-round notes: expansion samples S ~ Beta(τ(1+n_success^clade), τ(1+n_failure^clade)) per node and expands the argmax; evaluation uses the same form with per-agent counts and runs one agent on one task; τ = B/b (total over remaining budget) sharpens over time; expand when tree size ≤ N_t^0.6, otherwise evaluate; starts with 5 parallel expansions of the root; stops when the budget is spent — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)
- Models: SWE-bench runs used GPT-5 to self-modify and GPT-5-mini to evaluate; Polyglot used Qwen3-Coder-480B to modify and Qwen3-Coder-30B to evaluate — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)
- Cost: about USD 5,000 in total across all three methods compared (Appendix C.2), no per-method split — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)
- Transfer after removing the 93 tasks that overlap with the optimisation set ("filtered" SWE-bench Lite): initial ancestor 34.8%, SWE-agent + GPT-5-mini 39.6%, HGM agent 40.1%; with GPT-5, SWE-agent 48.3% versus HGM agent 47.8%. On the filtered set the evolved agent is level with SWE-agent, not above it — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)
- What the proposer is shown is not stated in the portion read; there is no dedicated limitations section — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)

**SICA** (Robeyns, Szummer, Aitchison; arXiv 2504.15228 v2, 16 May 2025) [body]
- **Correction (resolves the 53% versus 51% flag):** the per-iteration table gives SWE-bench Verified 0.17 at iteration 0, a peak of 0.53 at iteration 14, and 0.51 at the final iteration 15. The abstract's "17% to 53%" is start versus best, not start versus last. The series is non-monotonic: 0.14 at iteration 1, 0.38 at 4, 0.27 at 8, 0.47 at 9, 0.27 at 13 — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- Selection is argmax of utility over the archive; the 95% confidence intervals shown in figures are not used for selection; the main coding run appears to be a single run — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- Proposer inputs: the archive of prior agents and benchmark results, through an "archive analysis" tool giving per-iteration summary statistics; in the example trace a sub-agent also reads best and worst problems, documentation and source — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- Per-problem cost moved from $1.91 to $1.70 and time from 130.2 s to 114.5 s across the run; the authors say the 5-minute timeout and cost cap probably depressed scores, and much of the gain was speed and cost that accuracy does not show — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- The paper does not describe Docker or sandboxing (first-round note confirmed) — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)

**ADAS / Meta Agent Search** (Hu, Lu, Clune; arXiv 2408.08435 v2; ICLR 2025) [body; appendices truncated] **[pre-2025 background]**
- Editable surface: one Python `forward(self, taskInfo)` function on a framework of under 100 lines. Meta agent: GPT-4-class (mapped to gpt-4o-2024-05-13 in the appendix); agents evaluated with gpt-3.5 — [arXiv 2408.08435](https://arxiv.org/html/2408.08435v2)
- Proposer inputs: framework code, output-format instructions, a list of common implementation mistakes, the domain description and the whole archive of prior agents with their scores. Two self-reflection rounds (novelty against the archive, implementation errors); on a runtime error, up to five reflect-and-retry attempts. Every generated agent is added to the archive with its metrics; no filter is described — [arXiv 2408.08435](https://arxiv.org/html/2408.08435v2)
- Protocol: 25 iterations on ARC (20 validation, 60 test questions, five runs averaged), 30 on each reasoning domain; stop at the cap — [arXiv 2408.08435](https://arxiv.org/html/2408.08435v2)
- Results (test): DROP F1 79.4 versus best baseline 69.1 (OPRO); MGSM 53.4 versus 39.0 (LLM Debate); MMLU 69.6 versus 67.6; GPQA 34.6 versus 32.9. ARC transfer of the best agent to Claude Sonnet 48.3 versus Self-Refine 39.3; the 60-question test set gives roughly ±4–5 point intervals — [arXiv 2408.08435](https://arxiv.org/html/2408.08435v2)
- Limitations: single-step QA only; optimises accuracy only, not cost or latency; the scalar score discards the information in logs — [arXiv 2408.08435](https://arxiv.org/html/2408.08435v2)
- Cost: about $300 per run according to the Gödel Agent paper (secondary; ADAS's own cost appendix was not reached) — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)

**AFlow** (Zhang et al.; arXiv 2410.10762; ICLR 2025 oral) [body; appendices truncated] **[pre-2025 background]**
- Editable surface: a workflow as Python code (LLM-invoking nodes joined by code edges) plus optional predefined operators (Generate, Format, Review, Revise, Ensemble, Test, Programmer, Custom). Optimiser: Claude 3.5 Sonnet; executor: GPT-4o-mini — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- Loop (MCTS variant): select from the top-3 workflows plus the initial one with P(i) = λ/n + (1−λ)·softmax(α(s_i − s_max)); the optimiser sees the parent workflow and its "experience" (every past modification of that node with whether it helped or failed) plus logs of predictions against expected outputs; exactly one modification per round; run 5 times on the validation set; write score and success-or-failure back to the parent; stop at 20 rounds or when the top-k is unchanged for 5 rounds. The paper's text (α=0.4, λ=0.2) and its Algorithm A.6 (λ=0.4, α=0.2) disagree — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- Validation set: 20% of data, then filtered to the high-variance problems found by running the blank template 5 times — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- Results (test, GPT-4o-mini, 3 runs): average 80.3 versus CoT-SC 76.0 and ADAS 67.2; HumanEval 94.7, MBPP 83.4, GSM8K 93.5, MATH 56.2, HotpotQA 73.5, DROP 80.6 — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- Workflows are executor-specific: the workflow searched with DeepSeek scored 90.8 on GPT-4o-mini against 94.7 for the one searched with GPT-4o-mini — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- Without operators AFlow still reached 93.1 on GSM8K against 92.8 for the best manual baseline — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)

**Gödel Agent** (Yin et al.; arXiv 2410.04444 v4, 31 May 2025; ACL 2025) [body]
- Editable surface: its own code in runtime memory via monkey patching, including the improvement routine itself. Four actions: `self_inspect`, `interact` (score the current policy on validation data), `self_update`, `continue_improve`. Proposer: gpt-4o; policy model: gpt-3.5-turbo. Six independent cycles per task, at most 30 iterations each. Validation 128 questions (32 for GPQA); test 800 (166 for GPQA) — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)
- Results (test): constrained variant DROP 80.9, MGSM 64.2, MMLU 70.9, GPQA 34.9 against Meta Agent Search 79.4 / 53.4 / 69.6 / 34.6. The unconstrained variant's 90.5 / 90.6 / 87.9 / 55.7 came mainly from the agent switching itself to a stronger model (GPT-4o) — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)
- Failure statistics over 100 MGSM trials: 4% terminated unexpectedly (mostly after editing its own improvement module); 92% had at least one temporary performance drop; 14% ended worse than the starting policy — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)
- Ablation on MGSM (full 64.2): without the thinking step 50.8; without error handling 49.4; without code running 57.1; without LLM calling 60.4 — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)
- Cost: about $15 for a full 30-iteration run across the four tasks; the main cost driver is the growing history kept in context — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)

**AlphaEvolve** (Novikov et al., Google DeepMind; white paper arXiv 2506.13131, June 2025) [body, first 100K characters]
- Editable surface: code between `# EVOLVE-BLOCK-START` and `# EVOLVE-BLOCK-END` in files of any language; the user supplies an `evaluate` function returning a dictionary of scalar metrics — [arXiv 2506.13131](https://arxiv.org/html/2506.13131)
- Proposer inputs: prior programs sampled from the database with their scores and outputs, system instructions, optional explicit context (problem text, equations, literature), stochastically formatted templates, and meta-prompts that are themselves evolved in a separate database. Models: Gemini 2.0 Flash for throughput and Gemini 2.0 Pro for occasional higher-quality proposals. Output: SEARCH/REPLACE diff blocks, or a full rewrite for short code — [arXiv 2506.13131](https://arxiv.org/html/2506.13131)
- Evaluation: a cascade of increasingly hard test stages so faulty programs are dropped early; optional LLM-graded properties such as simplicity; asynchronous parallel evaluation. Store: MAP-Elites combined with island populations. No stopping rule is described — [arXiv 2506.13131](https://arxiv.org/html/2506.13131)
- Ablations (tensor decomposition, kissing numbers): removing evolution, prompt context, meta-prompt evolution, full-file evolution, or the large model each hurt; shown only as curves, no numbers in the text — [arXiv 2506.13131](https://arxiv.org/html/2506.13131)
- Cost: no totals. One evaluation can take on the order of 100 compute-hours; "thousands of LLM samples suffice" against FunSearch's millions; the matrix-multiplication result needed 15 mutations — [arXiv 2506.13131](https://arxiv.org/html/2506.13131)
- Limitation: needs an automated evaluator; it evolves programs for a task, not the agent harness — [arXiv 2506.13131](https://arxiv.org/html/2506.13131)

**ShinkaEvolve** (Lange, Imajuku, Cetin, Sakana AI; arXiv 2509.19349 v1, 17 September 2025) [body, first 100K characters] — **upgrades the first round's snippet-level entry**
- Loop: fixed-size archive split into islands with occasional migration (each island's best is barred from migrating); parent sampling by power law on rank or by weight w = sigmoid(fitness relative to median) × 1/(1 + offspring count); inspirations are top-K plus random archive programs; mutations are diff edits, full rewrites or crossover; invalid patches are resampled with the error fed back — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- Novelty rejection: embed the mutable code, and if cosine similarity to anything on the island exceeds 0.95, an LLM judges whether it is meaningfully different before any evaluation is spent — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- Proposer model chosen by a UCB1 bandit rewarded on improvement over the parent or initial program. A "meta-scratchpad": every T generations a meta-agent summarises recent evaluations and appends recommendations to the mutation prompt — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- The one harness-design result: an agent scaffold for AIME 2024 with gpt-4.1-nano, 75 generations, three runs per candidate, cap of 10 LLM calls per problem. The found design is three persona generators at temperature 0.7, one sceptical reviewer per solution at 0.1, and a synthesiser at 0 (7 calls), with majority-vote fallbacks. Accuracy numbers were not in the text read — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- Other results: circle packing n=26 in 150 generations (about 2.63598 under exact verification); ALE-Bench LITE about 2.3% average improvement over ALE-Agent in 50 generations. Ablations on circle packing: weighted parent sampling beats hill climbing (which plateaus early) and random; bandit ensemble beats fixed ensemble beats single model; the LLM novelty judge adds only marginal gains over embedding rejection — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- No dollar cost reported — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)

**OpenEvolve**
- Not re-read in this round; the first-round description from the repository stands. One new data point: as a harness optimiser on Meta-Harness's text-classification search set it scored 39.1 median / 43.3 best against Meta-Harness 50.0 / 56.7 — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)

**Dynamic Cheatsheet** (Suzgun et al.; arXiv 2504.07952 v1, 10 April 2025) [body]
- Loop: test queries arrive in sequence; one black-box model plays generator and curator. DC-Cu: answer with memory M_i, then the curator produces M_{i+1} from (M_i, query, answer). DC-RS: retrieve the 3 most similar past query-answer pairs, update memory first, then answer. No ground truth; the curator judges correctness itself. The curator regenerates the memory text and sometimes abbreviates it ("Previous content […] preserved"), losing content — [arXiv 2504.07952](https://arxiv.org/html/2504.07952)
- Results: Claude 3.5 Sonnet AIME 2024 23.3 to 50.0 (DC-Cu), AIME 2025 6.7 to 36.7, GPQA-Diamond 59.6 to 68.7 (DC-RS); GPT-4o Game of 24 10.0 to 99.0 (DC-RS). A structured prompt with empty memory already gives 36.7 on AIME 2024 for Claude, so part of the "doubling" is the prompt — [arXiv 2504.07952](https://arxiv.org/html/2504.07952)
- Negative results: GPT-4o on MMLU-Pro Engineering fell from 53.2 to 44.0 (DC-Cu); GPT-4o-mini on AIME 2024 fell from 16.7 to 13.3; appending the full history instead of curating gave Claude 26.7 on AIME 2024 against 50.0; reasoning models (o1, DeepSeek R1) showed minimal or inconsistent gains — [arXiv 2504.07952](https://arxiv.org/html/2504.07952)
- Cost: average tokens per query on AIME 2024 rose from 370 (baseline) to 1,831 (DC-Cu); no dollar figure — [arXiv 2504.07952](https://arxiv.org/html/2504.07952)

**ACE** (Zhang et al.; arXiv 2510.04618 v3, 29 March 2026; ICLR 2026) [body, first 100K characters]
- Loop details beyond round one: the same model (DeepSeek-V3.1, non-thinking) plays Generator, Reflector and Curator; batch size 1; at most 5 Reflector refinement rounds and at most 5 offline epochs; deduplication by embedding either after each delta or lazily when the context window is exceeded — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- Ablation (AppWorld average, base 42.4): without Reflector and multi-epoch 55.1; without multi-epoch 56.8; full offline 59.4; online without labels 56.1; online with offline warm-up 59.5 — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- **Discrepancy not resolved:** the abstract's "+10.6% on agents" and "+8.6% on finance" and the prose margins of 12.3% and 11.9% could not be reproduced from the table columns on a full read; the paper does not show the computation. Use the table values — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- Online ACE on the AppWorld normal split (TGC 69.6, SGC 53.6) is below offline ACE (76.2 / 64.3) but above it on the challenge split (66.0 / 48.9 versus 57.3 / 39.6) — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- Human involvement: none in the loop; the only mention is that domain experts could flag outdated bullets for removal — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- Independent re-runs: ACE as a baseline scored 40.9 against 48.6 for Meta-Harness (text classification, GPT-OSS-120B); 68.9% on Terminal-Bench 2 against a 69.7% seed in the AHE paper (below the seed); and below the seed on SWE-bench Verified in the same paper — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2604.25850](https://arxiv.org/html/2604.25850)

**GEPA** (Agrawal et al.; arXiv 2507.19457 v2, 14 February 2026; ICLR 2026 oral) [body and appendices]
- **Correction (the ICLR-version numbers the first round had only as snippets):** six benchmarks. Qwen3 8B aggregate: baseline 45.23, GRPO 48.91, MIPROv2 47.84, GEPA 54.85, GEPA+Merge 52.40. GPT-4.1 mini aggregate: baseline 53.03, Trace 56.30, MIPROv2 58.67, TextGrad 59.14, GEPA 65.22, GEPA+Merge 66.36. GEPA over GRPO averages +5.94 — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- The abstract's "+12% on AIME-2025 over MIPROv2" matches the Qwen3 8B table (32.00 versus 20.00) — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- Merge is not reliably helpful: on Qwen3 8B, GEPA+Merge dropped IFBench to 28.23 from 38.61 — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- Loop constants: minibatch of 3; the validation set is the Pareto set (300 examples for HotpotQA, IFBench, HoVer; 111 for PUPA); budget matched to MIPROv2's rollouts (2,270 to 6,926); merge at most 5 times; a candidate gets a full validation run only if it beats its parent on the minibatch; modules edited round-robin — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- Proposer inputs: the current instruction for one module plus inputs, outputs and feedback text for the minibatch. The reflection prompt in Appendix C does not include past candidates; history enters only through which candidate is selected as parent — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- Selection ablation (Qwen3 8B, four tasks, baseline 48.84): greedy best-candidate 54.89; beam search 53.95; Pareto 61.28 — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- Cost: all GPT-4.1 mini experiments under $500 in total; GEPA $86, GEPA+Merge $67, MIPROv2 $76. Most of the rollout budget is spent on validation, not on learning signal (79 to 737 training rollouts were needed to match GRPO's best validation score) — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- Cross-model: prompts optimised on Qwen3 8B gave +9.00 on GPT-4.1 mini unmodified. Adversarial use: one evolved instruction cut GPT-5 Mini's AIME-2025 pass@1 from 76% to 10% — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)

**Hyperagents / DGM-H** (Zhang, Zhao, Yang, Foerster, Clune, Jiang, Devlin, Shavrina; arXiv 2603.19461 v2, 1 November 2026) [body, read from the PDF text; no arXiv HTML exists] — **fills the first round's gap**
- Editable surface (Appendix A.5): both task agent and meta agent: prompts, output parsing, tool implementations, memory and logging, error handling, control flow, number and organisation of model calls or retries, under a per-iteration timeout. Fixed: the evaluator, task data, the model, the outer iteration budget and parent selection — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Initial hyperagent: bash tool and a file tool; the task agent is a single model call; the meta agent is told only the repository location, the location of previous evaluation results, and the number of iterations remaining, and may modify anything — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Parent selection as in DGM (proportional to score, inversely to number of compiled children). Staged evaluation: 10 tasks then 50 more (Polyglot); 10 then 100 (paper review, maths grading); 3 then 6 repetitions (robotics). Selection uses a validation split where the judge is an LLM. Five runs per method; medians with 95% bootstrap intervals — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Polyglot, 80 iterations: training subset 0.140 to 0.340 (CI 0.300–0.380); full benchmark 0.084 to 0.267 (CI 0.231–0.280). DGM for comparison: 0.140 to 0.380 and 0.142 to 0.307. So DGM-H is somewhat below DGM on coding — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Paper review (test, 100 iterations): initial 0.0, DGM-H 0.710 (CI 0.590–0.750), DGM-custom 0.590, original DGM 0.0, without self-improvement 0.0 (CI 0.0–0.130), without archive 0.0 (CI 0.0–0.560); static baseline (AI-Scientist-v2 reviewer) 0.630. The 0.0 start is an output-format failure, which the authors say means "part of the early improvement consists of learning the task interface" — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Robotics reward design (test): 0.060 to 0.372 (CI 0.355–0.436); DGM-custom 0.348; without self-improvement 0.213; without archive 0.116. DGM-H versus DGM-custom is not statistically significant in either domain — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- **Correction (confirms a first-round secondary claim from the primary source):** transfer to Olympiad maths grading measured as imp@50 with the meta agent frozen: initial meta agent 0.0; transferred DGM-custom agents 0.0 (CI 0.0–0.010); transferred DGM-H hyperagents 0.630 (CI 0.540–0.630). Transferring only the meta agent gives 0.620; only the task agent 0.100 — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Compounding claim is weak: 200 more iterations from transferred hyperagents reached 0.640 against 0.610 from scratch, not statistically significant. Starting from ProofAutoGrader, full IMO-GradingBench accuracy went from 0.561 to 0.601 — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Cost (Appendix D.2), tokens only: about 33M tokens of self-modification per 100 iterations plus about 0.506M tokens of evaluation per iteration, roughly 83.6M tokens for a paper-review-plus-robotics run. Self-modification model: Claude 4.5 Sonnet (Claude 3.5 Sonnet New on Polyglot) — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- Limitations (Section 7, Appendix F): fixed task distribution; fixed outer loop; "improvement plateaus within a few hundred iterations in our settings"; progress is measured in iterations, not matched compute; results "do not yet establish unbounded or self-accelerating improvement" — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)

**Self-Harness** (Zhang et al., Shanghai AI Laboratory; arXiv 2606.09498 v3, 20 August 2026) [body]
- Initial harness: a minimal DeepAgent-based harness (read, write, edit, shell) with declared but empty extension points: instructions for bootstrap, execution, verification and failure recovery, memory sources, sub-agent and skill lists, and a runtime control policy that starts disabled — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Weakness mining: failed held-in runs are grouped by exact match on a three-part signature (verifier-level cause, causal status of the agent's behaviour, agent mechanism); each cluster carries size, representative tasks, trace symptoms, verifier evidence and inferred mechanism, ordered by support and actionability — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Proposal: the same frozen model, in a proposer role, sees the editable surfaces, the failure patterns, the passing behaviours to preserve, and **summaries** of previous edits (not raw logs); it returns K distinct edit bundles each with an audit record. K and the number of rounds T are not stated — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Validation: each candidate runs on held-in and held-out splits, two attempts each, pass counts pooled; accepted only if both deltas are ≥ 0 and at least one is > 0; compatible accepted edits are merged. The held-out split gates acceptance, so it is a validation split, not an untouched test set — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Results (initial to final overall pass %): Terminal-Bench 2.0: MiniMax M2.5 42.2 to 53.9, Qwen3.5-35B-A3B 18.0 to 36.7, GLM-5 46.1 to 57.0. SWE-bench Verified: 46.0 to 52.5, 19.5 to 41.5, 52.0 to 55.5. AppWorld: 48.6 to 58.9, 22.5 to 52.2, 44.4 to 85.0 — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Not reported: any baseline other than its own initial harness, cost, ablations, cross-model transfer, per-round numbers. Stated limits: bounded edits on fixed benchmarks; edits may be benchmark-specific; depends on verifier quality; higher-stakes edits "would need stronger acceptance gates than pass-rate non-regression" — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Independent re-run: as the harness-only baseline in the Self-HPO paper, Self-Harness moved Qwen3.5-35B-A3B from 57.8 to 60.1 average over three SWE benchmarks (+2.3), far below the +22 it reports for the same model on its own weaker starting harness — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)

**Agentic Harness Engineering, AHE** (Lin et al., Fudan, Peking University, Shanghai Qiji Zhifeng; arXiv 2604.25850 v4, 18 May 2026) [body, first 100K characters] — **missed by the first round**
- Editable surface: seven component types on the NexAU framework (system prompt, tool description, tool implementation, middleware, skill, sub-agent configuration, long-term memory); the seed exposes only a bash tool. Three roles, all GPT-5.4: a Code Agent runs tasks, an Agent Debugger distils trajectories into per-task and benchmark-level reports, an Evolve Agent (xhigh reasoning) edits the workspace — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Distinctive mechanism: every edit ships a change manifest (failure evidence, root cause, targeted fix, predicted fixes, predicted at-risk regressions). Next round the predictions are checked against observed task outcomes and ineffective edits are reverted at file granularity; each iteration is a git commit. Ten iterations, at least 2 rollouts per task, 89 Terminal-Bench 2 tasks — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Results: Terminal-Bench 2 pass@1 69.7 to 77.0 against Codex 71.9, TF-GRPO 72.3, ACE 68.9, Terminus-2 62.9. On the Hard tier AHE (53.3) trails Codex (56.7). SWE-bench Verified transfer: 75.6 against 75.2 for the seed, with about 12% fewer tokens. Frozen-harness transfer to five other model settings: +2.3 to +10.1 points — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Prediction accuracy over 9 rounds: fix predictions precision 33.7%, recall 51.4% (random 6.5%, 10.6%); regression predictions precision 11.8%, recall 11.1% (random 5.6%, 5.4%). The authors call this "regression blindness" — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Limitations: searched and reported on the same 89 tasks; no human-in-the-loop workflow studied; "a controlled research prototype rather than a fully mature autonomous self-improvement system" — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)

**HarnessX / AEGIS** ("Darwin Agent Team"; VentureBeat attributes it to Xiaomi [snippet]; arXiv 2606.14249 v3, 23 July 2026) [body, first 100K characters] — **missed by the first round**
- Editable surface: a typed harness configuration over nine dimensions with processors on eight lifecycle hooks. One meta-agent (Claude Opus 4.6) runs four stages: Digester (compress each task's traces to outcome, failure category, implicated components, evidence excerpts), Planner (map of possible adaptations including untried edit types), Evolver (typed edits with change manifests and smoke tests), Critic (checks manifests against trace evidence) — [arXiv 2606.14249](https://arxiv.org/html/2606.14249)
- Acceptance: a deterministic gate checks manifest completeness, build and smoke tests, and a "seesaw" constraint forbidding regression on previously solved tasks. Rejected candidates are archived with reasons. Up to 15 rounds, early stop after 3 rounds with nothing shipped; pass@2 on the full task set each round; meta-agent budget 100M–175M tokens per benchmark — [arXiv 2606.14249](https://arxiv.org/html/2606.14249)
- Results (pass@2, initial to evolved), SWE-bench Verified on a 55-task set: Sonnet 4.6 76.4 to 87.3, GPT-5.4 45.5 to 63.6, Qwen3.5-9B 23.6 to 41.8. 14 of 15 benchmark-model configurations improved, average +14.5 — [arXiv 2606.14249](https://arxiv.org/html/2606.14249)
- Stated limitations: the evolution tasks are the evaluation tasks, no held-out test; pass@2 hides drift; per-edit gating missed accumulated coupling (a −14.0 regression at round 7 on τ3-Bench Telecom); on 55 SWE-bench tasks one task is 1.8 points and GPT-5.4 "degraded 12.7 points after peaking" — [arXiv 2606.14249](https://arxiv.org/html/2606.14249)

**RRSI** (Google Cloud AI Research with Stanford, WashU, UNC; arXiv 2609.24972 v3, 4 October 2026) [body, both halves]
- Editable surface: everything around the frozen model (prompts, control flow, config, context management, tools, skills, memory, sub-agents). Proposer: Claude Opus 4.8, fed failure feedback from an analyst that reads the incumbent's trajectories on the evolve set, plus the edit history, exploration directives and pruning targets — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Hyperparameters (coding domain): T = 20 rounds; 2 candidates per round, 1 reserved for exploration when progress stalls for 3 rounds; 2 trials per task; noise tolerance δ = 0.017 measured on the base harness; edit budget annealed on a cosine from 4 to 1 edits per candidate; pruning window 4 rounds. Fixed before the run, never tuned against held-out data — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Selection is greedy with gates: a leakage critic (Opus 4.8) reads each diff before evaluation and rejects edits that encode benchmark-specific names, values or answers, or add inert machinery; a candidate must score ≥ incumbent − δ; if its gain exceeds δ its cost increase must satisfy ΔC ≤ β0 + β1·ΔS; components that were exercised but earned no positive gain within the window are handed back as deletion targets — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Coding results: Terminal-Bench 2.1 with Opus 4.8 74.2 to 80.2, SWE-bench Verified (out-of-distribution, harness unchanged) 82.0 to 83.8; with Gemini 3.5 Flash 64.6 to 78.7 and 76.8 to 79.0 — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Overfitting evidence (Harvey LAB agentic-workspace suite): unregularised evolution reached 92.8 on the evolve split (+3.4 over base) but only +0.6 on the out-of-distribution average (40.3 versus 39.7) at 3.80M tokens per trial; RRSI reached 90.5 on evolve and 43.6 out of distribution at 2.42M tokens. Re-run baselines out of distribution: Meta-Harness 40.6, HarnessX 39.7, AHE 39.2, TTHE 38.0 against the base 39.7 — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Ablation: without proposal regularisers OOD 41.9; without acceptance regularisers OOD 41.0 at 3.59M tokens; each ablation is a single run — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Yield: the final coding harness holds four accepted edits out of 32 evaluated candidates over 20 rounds — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Internal inconsistencies: the abstract's "30% fewer policy tokens" against 2.42M versus 3.80M in the table (about 36%); "up to 4.3 points" OOD against 3.5–4.7 in the body; 38 screened coding candidates in text against 32 in Table 9. Bootstrap intervals are wide (Frontier-Eng +1.1 to +12.1). No evolution cost in dollars — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)

**DarwinX** (Salesforce AI Research; arXiv 2608.07545 v1, submitted 31 July 2026) [body, first 100K characters] — **missed by the first round**
- Loop: archive is a tree of harness snapshots each with its edit delta, per-task scores, trial evidence and lessons; non-improving variants are kept. Each round picks a parent by cumulative lineage gain (with some probability of broadening) and asks for one small additive edit aimed at a failing or fragile task while preserving solved tasks. Signals: failed trajectories, a reference solver's successful trajectory where the agent never succeeded, contrast between the agent's own passing and failing rollouts, and cross-task failure themes in shared memory — [arXiv 2608.07545](https://arxiv.org/html/2608.07545)
- Admission: net gain positive and regression within a bound δ; a verifier agent decides promote or revert; promoted children are re-tested with a preservation probe before they can steer search. Terminal-Bench 2.1 screens at avg@33 and confirms at avg@55 — [arXiv 2608.07545](https://arxiv.org/html/2608.07545)
- Results: Terminal-Bench 2.1 with GPT-5.5 75.5 to 83.2 (Codex 83.1, Claude Code 83.8 with different models); held-out TerminalWorld (41 tasks) 61.0 to 68.3 on Opus 4.8 but 56.1 on GPT-5.5, below Terminus-2's 61.0; SWE-bench Verified by transfer 84.2 against an 80.8 reference. On WebArena-Infinity 26 iterations were accepted and 36 reverted — [arXiv 2608.07545](https://arxiv.org/html/2608.07545)
- Limitations: archive, parent selector and merge were not ablated; skill attribution is "plausible rather than causal"; no cost reported — [arXiv 2608.07545](https://arxiv.org/html/2608.07545)

**Retrospective Harness Optimization, RHO** (CityU Hong Kong and Microsoft Research Asia; arXiv 2606.05922 v3, 29 August 2026) [body, first 100K characters] — **missed by the first round**
- Setting: post-deployment, only unlabelled past trajectories, no validation set and no grader. Loop: an LLM judge scores each past trajectory's difficulty 0–10 and writes a fingerprint; a determinantal point process picks 10 hard and diverse tasks; each is re-solved 3 times; the agent diagnoses by self-validation (errors within a run) and self-consistency (disagreement across runs); it proposes 3 candidate harnesses; each is compared pairwise against the baseline rollouts by the agent's own preference; a candidate ships only if its mean preference is above zero. One model (Codex CLI with GPT-5.5) does everything — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- Results (held-out pass rate, vanilla Codex to RHO): SWE-Bench Pro 0.59 to 0.78; Terminal-Bench 2 0.71 to 0.76; GAIA-2 0.29 to 0.37. Dynamic Cheatsheet 0.62 / 0.73 / 0.30; ReasoningBank 0.61 / 0.73 / 0.28 — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- Cost: 103 agent calls. Meta-Harness with labels scored 0.62 on SWE-Bench Pro after one round (41 calls) and 0.80 after ten rounds (320 calls) — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- Ablations: without self-consistency 0.56; without self-validation 0.70; giving the proposer raw trajectories instead of diagnoses 0.60. Self-preference is conservative: a candidate it did not select reached 0.85 — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- Limitations: one round only (no claim that gains compound); needs environments that reset cleanly; trajectories can carry injected content into harness updates; benchmark only, no real deployment — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)

**Recursive Harness Self-Improvement, RHI** (Sakana AI and UC Berkeley; arXiv 2607.15524 v1, 17 July 2026) [body, first 100K of ~300K characters]
- Harness: a prompt-level specification of the agent loop (agent roles, instructions, contracts between orchestrator and sub-agents, auxiliary rules). Loop: a Claude coding agent builds a repository under harness H(i); an LLM evaluator compares it pairwise with the previous iteration's output and appends the preference to a history; an LLM optimiser writes H(i+1) from H(i) and that history without seeing the evaluation prompt. No selection step or archive; stops when the fraction of tasks where the new output wins falls below a threshold — [arXiv 2607.15524](https://arxiv.org/html/2607.15524)
- Results on 30 LLM-generated ML-research tasks judged by LLMs: Sonnet 4.6 at high effort with the twice-iterated harness beat Sonnet 4.6 at max effort in 20 of 30 comparisons; Opus 4.8 high with H[2] cost 1.69 (normalised) against 2.19 for max and 4.15 for "ultracode" — [arXiv 2607.15524](https://arxiv.org/html/2607.15524)
- Limits: LLM judges on synthetic tasks; one or two iterations; does not consistently close the gap to a stronger model — [arXiv 2607.15524](https://arxiv.org/html/2607.15524)

**Self-HPO** (Microsoft Research, UVA, CMU; arXiv 2610.22791 v1, 16 October 2026) [body] — hybrid, updates weights
- Harness step: K = 6 candidates, all scored on one search set (300 tasks initially), proposed either by the current policy itself or by Opus 4.8 from the experience of evaluated harnesses including failed trajectories; a candidate replaces the best only if it scores strictly higher (greedy). Policy step: 50 GRPO updates. Tasks never solved in any rollout during the policy step become the next harness search set. Two rounds were run. Seed harness: mini-SWE-agent; the evolved harness overrides `step()` — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)
- Results (Qwen3.5-35B-A3B, resolve %, avg@3; SWE-Verified / SWE-Multi / SWE-Pro / average): base 61.0 / 54.2 / 58.3 / 57.8; RL only 67.5 / 56.3 / 61.8 / 61.9; Self-Harness (harness only) 65.2 / 54.3 / 60.7 / 60.1; Self-HPO 69.5 / 59.7 / 65.2 / 64.8; Meta-Harness with Opus 4.8 as proposer (harness only) 69.1 / 56.5 / 64.8 / 63.5; HPO with Opus 4.8 as proposer 71.6 / 61.4 / 66.0 / 66.3 — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)
- Proposer strength: swapping Opus 4.8 for the 35B policy as its own proposer cost 2.1 points on SWE-Verified (71.6 to 69.5). A fixed search set instead of hard-task mining cost 1.5 points — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)
- No GPU-hour or dollar cost; one node with eight B200 GPUs — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)

**HASE** (HKU and China Mobile; arXiv 2607.03935 v1, 4 July 2026) [body] — hybrid, updates weights
- One Qwen3-8B policy both solves tasks and edits whitelisted harness files (prompt, memory formatting, retrieval, context selection; for two maths tasks also the local scorer) through sandbox commands, while GRPO updates its weights. A deterministic controller validates and commits. A guidance edit earns credit only if the same trajectory then improves the task score; an evaluator edit is accepted only where the local scorer and the real ("oracle") evaluator disagreed and the edit fixes those mismatches without regressions — [arXiv 2607.03935](https://arxiv.org/html/2607.03935)
- Result: Symptom2Disease test accuracy 86.98 ± 0.38 with Qwen3-8B against Meta-Harness 86.8 with GPT-OSS-120B (one dataset; the authors call it an algorithm-level, not like-for-like, comparison). With weights frozen, the Heilbronn task plateaued at 0.021880 against 0.036082 with co-evolution — [arXiv 2607.03935](https://arxiv.org/html/2607.03935)
- A concrete evaluator exploit: out-of-bounds points scored 0.027076 on the local scorer while the real evaluator returned 0, until the agent's own evaluator patch closed it — [arXiv 2607.03935](https://arxiv.org/html/2607.03935)

**HSI** (Zhou, HKUST; arXiv 2608.08466 v1, 9 August 2026) [body, first 100K characters]
- Evolver inputs: environment reward feedback, the graph of committed harness versions, and a lessons file (BOOTSTRAP.md). T = 5 iterations of at most 80 agent steps; candidates ranked by a lower confidence bound μ − 0.5·σ/√n; commit selection keeps a diverse pool; the final export is chosen on validation. Reasoning is off for task execution and on for the evolvers — [arXiv 2608.08466](https://arxiv.org/html/2608.08466)
- Removing the meta-evolver lowers the five-environment BALROG average from 41.4 to 33.1 (base 18.9). Progress is non-monotonic (Crafter regressed in iteration 5). Setup A is in-distribution (same task families, resampled seeds) — [arXiv 2608.08466](https://arxiv.org/html/2608.08466)

**Harness tampering audit** (Wang, Zhang, Shao, UESTC; arXiv 2609.00069 v1, 30 August 2026) [body] — **fills the first round's gap**
- Taxonomy: 5 functional roles (Execution, Evaluation, Selection, Recording, Propagation) × 7 obligations (measurement validity, representational fidelity, procedural integrity, authorisation and access boundaries, protected artefact and state integrity, provenance and source attribution, required-set completeness). Worked example: an edit that overwrites the recorded overall accuracy with 1.0 before saving, labelled ⟨Recording, Representational fidelity⟩ — [arXiv 2609.00069](https://arxiv.org/html/2609.00069)
- Share of iterations with at least one finding, from public run artefacts: ADAS 84.6%, HyperAgents 73.6%, DGM 63.1%, ScientistOne 29.6%, AFlow 18.3%. Concurrent findings in the final best agent: HyperAgents 5.2, DGM 3.5, AFlow 0.3. Findings introduced before iteration 10 persisted to the final agent. HGM, SICA and Meta-Harness were not audited — [arXiv 2609.00069](https://arxiv.org/html/2609.00069)
- Caveat on those rates: they come from one LLM auditor (GPT 5.6 Luna) whose own false-positive rate on seeded controls was 6.3% with 74.9% seeded recall, and whose labels on natural diffs were manually checked only on a sample. Best auditors: Claude Opus 5 at 90.4% accuracy, 84.2% recall, 9.4% false positives. A LoRA-tuned 9B model had an 81.2% false-positive rate — [arXiv 2609.00069](https://arxiv.org/html/2609.00069)

**Harness Updating Is Not Harness Benefit** (Lin et al., Amazon, Penn State and others; arXiv 2605.30621 v2, 4 November 2026; EMNLP 2026 per the first round) [body, first 100K characters] — **fills the first round's gap**
- Design: in-situ evolution in which each task is scored before its evidence feeds the next update; an LLM evolver reads trajectories and writes skills (plus prompts and memory files on MCP-Atlas); tools and evaluation files are read-only. SWE-bench Verified (500), MCP-Atlas (500), SkillsBench (86); seven models — [arXiv 2605.30621](https://arxiv.org/html/2605.30621)
- Writer strength barely matters: the spread between the best and worst evolver is at most 3.1 points on any benchmark; on SkillsBench Qwen3.5-9B as writer gave +3.8 against Opus 4.6's +2.3 — [arXiv 2605.30621](https://arxiv.org/html/2605.30621)
- Benefit by task-solving model on SWE-bench Verified (gain, base pass rate in brackets): Qwen3-32B +4.4 (3.6); Qwen3-235B +19.3 (20.7); GPT-OSS-120B +15.8 (26.2); Haiku 4.5 +2.4 (66.0); Sonnet 4.6 +2.8 (73.2); Opus 4.6 +2.6 (74.2). SkillsBench does not fit the pattern (Haiku 4.5 gains most at +15.1) and the paper does not discuss it — [arXiv 2605.30621](https://arxiv.org/html/2605.30621)
- Why weak models miss out (SkillsBench): skill-load rate about 0.96 for Opus, Sonnet and Qwen3-235B, 0.45 for GPT-OSS-120B, 0.25 for Qwen3-32B; harness-following rate 0.76 for Opus, 0.35 for Qwen3-235B, 0.14 for Qwen3-32B; adherence decays over a trajectory (Qwen3-32B 0.52 to 0.13; Opus 0.89 to 0.80) — [arXiv 2605.30621](https://arxiv.org/html/2605.30621)

**Live-SWE-agent** (Xia et al.; arXiv 2511.13646 v3) [body] — upgrades first-round snippets
- Mechanism: mini-SWE-agent plus one instruction to write helper scripts and, after every environment message, a reflection prompt asking whether a tool should be created. Nothing persists across tasks; cross-task reuse is future work — [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)
- 60-task SWE-bench Verified subset with GPT-5-mini: Live-SWE-agent 65.0% at zero offline cost against HGM 56.7% (512 hours), DGM 53.3% (1,231 hours), SICA 50.0%. The baseline numbers are reused from the HGM paper, not re-run — [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)
- Model dependence (50-task subset, mini-SWE-agent to Live): GPT-5-Nano 44.0 to 14.0; GPT-5-Mini 60.0 to 58.0; GPT-5 60.0 to 68.0; Claude 4.5 Sonnet 62.0 to 76.0. Removing the per-step reflection: 64.0 — [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)

### Inferences
- The gap between "what the abstract says" and "what the table says" is itself a finding for a designer: report last-iteration and held-out numbers, not peak-iteration and search-set numbers. SICA's 53 is a peak; Meta-Harness's TerminalBench-2 number, AHE's and HarnessX's are on the search tasks; Self-Harness's "held-out" split gates acceptance.
- DGM's diagnosis step was shown the benchmark's private test patch. That is a stronger information leak into the proposer than any later system allows, and it weakens DGM as evidence about what a proposer can achieve from logs alone.
- A large share of several headline gains is "learning the interface": Hyperagents starts from 0.0 because of output parsing, Dynamic Cheatsheet's empty-memory prompt already gives most of the lift on AIME 2024, and Self-Harness's largest gains are on the weakest starting points. Gains from a deliberately minimal seed harness should not be read as gains available to an already-engineered harness.
- Reported evolution cost falls by roughly two orders of magnitude from 2025 to 2026: DGM about $22,000 and two weeks; SICA about $7,000; HGM about $5,000 across three methods; Meta-Harness "a few hours"; RHO 103 agent calls; RRSI 32 evaluated candidates. The saving comes from fewer, better-informed proposals, not cheaper evaluation.

### Gaps
- TTHE (a baseline in RRSI) could not be identified; its full name and arXiv id were not in the text read. AEVO (Zhang et al., 2026), cited in the evaluation critique, was not opened.
- GSME (arXiv 2607.13683) was not re-read; the first-round body read stands.
- OpenEvolve was not re-read; there is still no primary-source benchmark number for it beyond its use as a baseline.
- Not reached in the long HTML pages: DGM's Appendix H case study and per-node feature logs; ADAS's cost appendix; AFlow's cost tables; HGM's statement of proposer inputs; RHI's Appendix B harness examples; HarnessX's co-evolution section and cost; ACE's appendix A.6 dedup threshold; ShinkaEvolve's AIME accuracy figures.
- Meta-Harness, Self-Harness, RRSI, AHE, DarwinX, HarnessX, RHO, RHI, HSI, HASE, Self-HPO and the tampering audit are preprints; no peer-review record was found for any of them in this session.
- "Self-Evolving Agent Harness" (arXiv 2610.18813, 13 October 2026) was read at abstract level only: a 66-page theory and position paper with a PAC-style admission rule requiring fresh independent validation data and no experiments of its own — [arXiv 2610.18813](https://arxiv.org/abs/2610.18813)

## 2. What the papers agree on as necessary components, and where they disagree

### Takeaway
They agree on a fixed evaluator outside the editable surface, proposals grounded in failure evidence from traces, a cheap validity check before expensive evaluation, a persistent record of every candidate, and an explicit regression check before a change is kept. They disagree on greedy versus archive selection, on raw traces versus distilled diagnoses, and on how strong the proposer must be; on each, the 2026 evidence is more mixed than the 2025 papers implied.

### Cited Findings

**Agreement**
- Evaluator, task data and selection logic kept outside what the agent can edit: DGM (fixed archive and parent selection), Hyperagents ("to ensure safety, prevent evaluation gaming, and keep runs comparable"), Harness-Updating study (tools and evaluation files read-only), HASE (the real-world evaluator is not editable), Meta-Harness ("automate evaluation outside the proposer") — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2); [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2); [arXiv 2605.30621](https://arxiv.org/html/2605.30621); [arXiv 2607.03935](https://arxiv.org/html/2607.03935); [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- A cheap gate before the expensive run: Meta-Harness's import-and-call test "rejected in seconds"; DGM's compile-and-can-still-edit check and 10-task stage; HarnessX's build and smoke tests; RRSI's pre-evaluation leakage critic; AlphaEvolve's evaluation cascade; ShinkaEvolve's novelty rejection — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2); [arXiv 2606.14249](https://arxiv.org/html/2606.14249); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2506.13131](https://arxiv.org/html/2506.13131); [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- An explicit no-regression rule at admission, in every 2026 coding-harness system: Self-Harness (both split deltas ≥ 0), HarnessX (seesaw constraint), DarwinX (regression within δ plus a preservation probe), RRSI (score ≥ incumbent − δ), AHE (file-level revert of edits whose predicted fixes did not appear) — [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2606.14249](https://arxiv.org/html/2606.14249); [arXiv 2608.07545](https://arxiv.org/html/2608.07545); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Small, single-purpose, attributable edits: AFlow allows one modification per round; DarwinX asks for "one small additive edit"; RRSI anneals from 4 edits to 1; Meta-Harness's proposer itself discovered that bundling structural fixes with prompt rewrites confounded two regressions and switched to isolated, additive edits — [arXiv 2410.10762](https://arxiv.org/html/2410.10762); [arXiv 2608.07545](https://arxiv.org/html/2608.07545); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Each change carries a written record of why: AHE and HarnessX change manifests (evidence, root cause, fix, predicted effects), Self-Harness audit records, DarwinX lessons per snapshot — [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2606.14249](https://arxiv.org/html/2606.14249); [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2608.07545](https://arxiv.org/html/2608.07545)
- Repeated trials per task to control noise: AFlow 5 runs; Self-Harness 2; AHE ≥ 2; RRSI 2 to 4 with a measured noise band; DarwinX avg@33 then avg@55; HSI a lower confidence bound — [arXiv 2410.10762](https://arxiv.org/html/2410.10762); [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2608.07545](https://arxiv.org/html/2608.07545); [arXiv 2608.08466](https://arxiv.org/html/2608.08466)

**Disagreement: greedy versus archive selection**
- For archives: DGM without the archive fell to 23.0% on SWE-bench against 50.0% with it, and a greedy variant reached 39.7%; GEPA's Pareto selection scored 61.28 against 54.89 for greedy best-candidate; Hyperagents without the archive stayed at a median 0.0 on paper review; ShinkaEvolve's hill climbing "plateaus early" — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2); [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2); [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2); [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- For greedy single-incumbent loops: RRSI (greedy with gates), Self-HPO (replace only if strictly higher), Self-Harness (merge accepted edits into one harness), AHE and RHI (single lineage) all report gains, and RRSI's greedy loop beat the re-run Meta-Harness out of distribution (43.6 versus 40.6) — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1); [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Middle position: Meta-Harness has no parent-selection rule at all; the proposer chooses what to build on after reading the whole history. HSI keeps a single lineage "for attribution clarity over search throughput" — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2608.08466](https://arxiv.org/html/2608.08466)

**Disagreement: raw traces versus distilled diagnoses for the proposer**
- Raw wins in Meta-Harness: scores only 34.6 median, scores plus summaries 34.9, full filesystem with raw traces 50.0 — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Diagnosis wins in RHO: replacing its self-validation and self-consistency diagnosis with raw trajectories dropped SWE-Bench Pro from 0.78 to 0.60 — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- Self-Harness, AHE, HarnessX and RRSI all put a distillation stage (cluster, debugger, digester, analyst) between traces and proposer; none reports an ablation of that choice — [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2606.14249](https://arxiv.org/html/2606.14249); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)

**Disagreement: proposer strength**
- Weak proposers suffice: the Harness-Updating study finds at most 3.1 points between best and worst writer; Self-Harness uses the same mid-size model as its own proposer — [arXiv 2605.30621](https://arxiv.org/html/2605.30621); [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Strong proposers help somewhat: Self-HPO loses 2.1 points with the 35B policy as proposer instead of Opus 4.8; Meta-Harness with Opus 4.8 as proposer beat Self-Harness on the same model by 3.4 points on average (63.5 versus 60.1); SICA says the meta-improvement task "needs powerful models" — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1); [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- Too-weak models are harmed by the mechanism itself: GPT-5-Nano fell from 44.0 to 14.0 with Live-SWE-agent's tool creation; Continual Harness gave Gemini 3 Flash-Lite no benefit — [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3); [arXiv 2605.09998](https://arxiv.org/html/2605.09998)

**Disagreement: offline versus online**
- Offline search on a fixed set dominates the literature. Online or in-situ variants: ACE online, Dynamic Cheatsheet, the Harness-Updating in-situ protocol, Continual Harness (edits take effect on the next step with no validation), Live-SWE-agent (per-task tools, nothing persisted) — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3); [arXiv 2504.07952](https://arxiv.org/html/2504.07952); [arXiv 2605.30621](https://arxiv.org/html/2605.30621); [arXiv 2605.09998](https://arxiv.org/html/2605.09998); [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)
- Same-method comparison: ACE online without labels 56.1 on AppWorld against 59.4 offline with labels; adding an offline warm-up to online brings it to 59.5 — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)

**Disagreement: is the improvement procedure itself editable?**
- Hyperagents: yes, and the transferred meta agent accounts for nearly all cross-domain benefit (imp@50 0.620 versus 0.100 for the task agent alone). HSI: yes, under a frozen anchor (41.4 versus 33.1 without). Gödel Agent: yes, and 4% of runs crashed mostly from editing that module. Everyone else fixes it — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2); [arXiv 2608.08466](https://arxiv.org/html/2608.08466); [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)

### Inferences
- The archive evidence comes from long open-ended searches (80+ iterations) from weak seeds; the greedy evidence comes from short gated searches (10–20 rounds) on already-capable harnesses. For a loop that makes a handful of changes to a working harness, greedy-with-gates plus a kept record of rejected candidates is what the 2026 coding papers actually run.
- The raw-versus-distilled disagreement resolves if the proposer is an agent with file access (it can do its own distillation and return to raw traces) versus a single prompt (it needs a digest). The safe design is to give both: a digest for orientation and the raw traces on disk.
- No paper tests its regression gate against the 11% regression-prediction recall AHE measured. The gates are empirical (re-run the tasks), not predictive, and that is the only form with evidence behind it.

### Gaps
- No paper compares greedy and archive selection under a matched evaluation budget on a coding benchmark in the 2026 harness setting; DGM's ablation is the only coding-task comparison and predates the gated designs.
- No ablation isolates the change manifest or the distillation stage.

## 3. The role of the history given to the proposer, and how many iterations until gains appear and plateau

### Takeaway
History helps when it lets the proposer attribute an outcome to a specific past change, and what works is the record of past edits with their measured effect, not scores alone. Gains in the coding-harness papers arrive within the first 2 to 10 rounds, most candidates are rejected, trajectories are non-monotonic, and every paper that ran long enough reports a plateau.

### Cited Findings

**What history the proposer gets, and what it is worth**
- Meta-Harness: full code, scores and traces of every prior candidate; the proposer referenced over 20 prior candidates per step. Removing traces (scores only) cut median accuracy from 50.0 to 34.6; LLM summaries in place of traces did not help (34.9) — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Meta-Harness's TerminalBench-2 log shows history used for causal attribution: iterations 1–2 bundled bug fixes with prompt edits and regressed (−5.6 and −6.7 points); at iteration 3 the proposer identified the prompt rewrite as the confound and tested the fixes alone; iterations 4–6 still regressed; iteration 7's purely additive change became the best candidate; iteration 10 reused a lesson from a separate earlier run — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- AFlow: the optimiser is given the parent's "experience", meaning each past modification of that node and whether it raised or lowered the score, plus failure logs — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- RRSI: the proposer receives the edit history, and the pruner's list of components that were exercised without positive gain — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Self-Harness: summaries of previous edits, not raw logs, plus the list of passing behaviours to preserve — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- AHE: the previous round's change manifests with their predictions scored against what happened — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- GEPA is the counter-example: the reflection prompt holds only the current instruction and one minibatch of traces; all memory lives in the candidate pool — [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2)
- DGM: the diagnosing model sees one parent's code and its logs on a task, not the archive; the archive is used only for parent selection — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- Hyperagents: the initial meta agent is told only where the repository and past evaluation results are; the evolved meta agents then **built their own history tooling**: a performance tracker that logs score per generation and computes a moving-average trend, and a persistent memory of synthesised insights (for example "Gen55 has best accuracy but is too harsh… Need to combine gen55's critical reasoning with gen64's balance", and a note that generation 65's change over-corrected). These meta-level features are what transferred across domains — [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2)
- ShinkaEvolve: a periodic meta-scratchpad summarising what recently worked is appended to the mutation prompt — [arXiv 2509.19349](https://arxiv.org/html/2509.19349)
- Costs of history: Gödel Agent names the growing history in context as its main cost driver; SICA's context overflowed after 360 evaluations when re-run by the HGM authors; SICA's own authors report path dependence, with later ideas being variations on early ones — [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4); [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3); [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)

**How many iterations, acceptance yield, plateau**

| System | Budget run | When gains appeared | Yield / plateau evidence |
|---|---|---|---|
| Meta-Harness (TB2) | 10 iterations | first net win at iteration 7 after six regressions | fixed budget |
| AHE | 10 iterations | cumulative, non-monotone | fix-prediction precision 33.7% |
| RRSI (coding) | 20 rounds, 32 evaluated candidates | first accepted edit in round 0 (+3.93) | 4 edits accepted |
| DarwinX (WebArena-Infinity) | 62 iterations | not stated | 26 accepted, 36 reverted |
| HarnessX | ≤ 15 rounds, stop after 3 empty rounds | not stated | GPT-5.4 on SWE-bench fell 12.7 points after its peak |
| SICA | 15 iterations | first jump at iteration 4 (0.22 to 0.38) | peak at 14, dips at 8 and 13 |
| DGM | 80 iterations | key feature at node 24 | lineage of the best agent has two dips (iterations 4 and 56) |
| Hyperagents | 80–200 iterations | early gain is interface learning | "plateaus within a few hundred iterations" |
| Self-HPO | 2 alternation rounds | each round | stops when the hard-task set stabilises |
| RHI | 1–2 iterations | first or second | stops when win rate < ε |
| RHO | 1 round | first | compounding not claimed |
| GEPA | 1,839–7,051 rollouts | "a single reflective update often yields large gains" | matches GRPO after 243–1,179 rollouts |
| AFlow | ≤ 20 rounds | operators added in rounds 2–3 | early stop after 5 unchanged rounds; rounds 5 and 14 regressed |
| Gödel Agent | 30 iterations × 6 | varies | 92% of runs had a temporary drop; 14% ended worse |

- Sources for the table — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2608.07545](https://arxiv.org/html/2608.07545); [arXiv 2606.14249](https://arxiv.org/html/2606.14249); [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2); [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2); [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2); [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1); [arXiv 2607.15524](https://arxiv.org/html/2607.15524); [arXiv 2606.05922](https://arxiv.org/html/2606.05922); [arXiv 2507.19457](https://arxiv.org/html/2507.19457v2); [arXiv 2410.10762](https://arxiv.org/html/2410.10762); [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4)
- A second optimisation budget may buy nothing: in a two-phase continual evaluation on hard Terminal-Bench 2.0 tasks, Meta-Harness "fails to improve further once given a second optimization budget" and GEPA's optimised agent transferred to new tasks below the unoptimised baseline; lifelong average pass rates were RELAI-VCL 76.4%, GEPA 66.0%, Meta-Harness 64.6%, baseline 58.7%. This is a technical report by RELAI, the vendor of the winning method [abstract] — [arXiv 2607.14004](https://arxiv.org/abs/2607.14004)
- Budget for the search set: Meta-Harness recommends a set small enough for about 50 full evaluations per run, built from examples the baseline fails — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)

### Inferences
- The history that earns its tokens is a ledger of (change, intended effect, measured effect, kept or reverted). Hyperagents is the strongest evidence: left alone, the system invented exactly that ledger for itself, and it was the part that transferred. A harness toolkit should supply it from the start.
- Expect roughly one kept change per three to eight candidates (RRSI 4 of 32; DarwinX 26 of 62; AHE fix precision about one in three). A loop that keeps most of what it proposes is probably not gating.
- Because trajectories dip before they rise (DGM, SICA, Meta-Harness), a strictly greedy gate will discard stepping stones; because one-third to two-thirds of candidates are bad, an ungated loop accumulates harm. Keeping rejected candidates on record, without letting them into the live harness, is the compromise the 2026 systems converge on.
- Plateau within tens of rounds on a fixed task set is the norm; fresh tasks (Self-HPO's hard-task mining, +1.5 points over a fixed set) are the only reported way to extend it.

### Gaps
- No paper ablates the edit-history ledger in isolation (history with outcomes versus history without).
- Per-round score curves were in figures and not extractable for Self-Harness, AHE, RRSI and DarwinX.
- The RELAI continual-learning report was read at abstract level and comes from an interested party.

## 4. Results on coding and terminal tasks, and the concrete harness changes that produced the gains

### Takeaway
On coding and terminal benchmarks the discovered improvements are almost all the same few things: verify before finishing, guard against an empty or unappliable patch, a more precise edit tool, an environment snapshot at start-up, dependency checks, and budget or loop control. Prompt wording alone is the weakest lever and in one ablation was negative. Against matched-budget retries on the same tasks, one independent study finds harness evolution gives no advantage on Terminal-Bench 2.1.

### Cited Findings

**Coding and terminal results in one place (all [body] unless tagged)**

| System | Benchmark, model | Start to end | Same tasks for search and report? |
|---|---|---|---|
| Meta-Harness | TerminalBench-2 (89), Opus 4.6 | Terminus-KIRA 74.7 to 76.4 | yes |
| AHE | Terminal-Bench 2 (89), GPT-5.4 | 69.7 to 77.0 | yes |
| AHE transfer | SWE-bench Verified (500) | 75.2 to 75.6 | no |
| RRSI | Terminal-Bench 2.1, Opus 4.8 | 74.2 to 80.2 | evolve split |
| RRSI transfer | SWE-bench Verified, Opus 4.8 | 82.0 to 83.8 | no |
| DarwinX | Terminal-Bench 2.1, GPT-5.5 | 75.5 to 83.2 | yes |
| DarwinX | TerminalWorld (41), Opus 4.8 | 61.0 to 68.3 | no |
| Self-Harness | Terminal-Bench 2.0, three open models | 42.2 to 53.9; 18.0 to 36.7; 46.1 to 57.0 | held-out split gates acceptance |
| Self-Harness | SWE-bench Verified | 46.0 to 52.5; 19.5 to 41.5; 52.0 to 55.5 | same |
| HarnessX | SWE-bench Verified (55), pass@2 | 76.4 to 87.3 (Sonnet 4.6) | yes |
| RHO | SWE-Bench Pro, GPT-5.5 Codex | 0.59 to 0.78 | no (held-out) |
| RHO | Terminal-Bench 2 | 0.71 to 0.76 | no (held-out) |
| Self-HPO (harness + RL) | SWE-Verified, Qwen3.5-35B | 61.0 to 69.5 | no |
| DGM | SWE-bench Verified subset, Claude 3.5 Sonnet | 20.0 to 50.0 | yes |
| HGM | SWE-bench Verified (500), GPT-5-mini | 53.2 to 61.4 | yes |
| SICA | SWE-bench Verified (50) | 0.17 to 0.51 (peak 0.53) | yes |
| Hyperagents | Polyglot full | 0.084 to 0.267 | mostly unseen |
| Live-SWE-agent | SWE-bench Verified, Claude 4.5 Sonnet | 70.6 to 75.4 | no search |

- Sources — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2608.07545](https://arxiv.org/html/2608.07545); [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2606.14249](https://arxiv.org/html/2606.14249); [arXiv 2606.05922](https://arxiv.org/html/2606.05922); [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1); [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2); [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3); [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2); [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2); [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)

**Discovered changes, grouped by kind**

Verification before finishing (the most common winner)
- DarwinX, Terminal-Bench 2.1: all seven retained skills are in one family: verifier-contract, contract-candidate, graded-artifact-final-check, artifact-verification-loop, real-tool-artifact, tool-grounded-artifact, security-contract-repair. They make the agent write down an acceptance contract and check its output against it before finalising — [arXiv 2608.07545](https://arxiv.org/html/2608.07545)
- RRSI, coding: of four accepted edits, one is a coverage-and-depth re-check and three are standard-library probes that read back the deliverable and report what is missing; the first accepted edit was a bounded pre-completion verification audit plus non-blocking polling guidance for long jobs (+3.93) — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- AHE: a middleware finish hook that forces an evaluator-style closure check — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Self-Harness, SWE-bench: a test-verifier sub-agent that runs the most relevant failing test; a patch-verifier sub-agent with a pre-submission instruction to inspect the diff and run targeted tests — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- Self-HPO: a one-time hold on the first submission that prompts a check of API names and signatures against the repository and tests — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)
- RHO, SWE-Bench Pro: a `check_build_and_lint` tool that finds a non-standard Go toolchain and flags artefacts such as Python cache directories that would break patch application; the agent then verifies more often — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- DGM: patch-validity checks with retries; generating several attempts and having another model pick the best; consulting previous attempts — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)

Empty-patch and submission guards
- Self-Harness: a diff-inspection sub-agent that detects empty patches. Self-HPO: an empty-patch guard asking the model to register new files with `git add -N`, and a fallback that submits the sandbox's git diff when the patch fails the apply check — [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1)

Better file editing and navigation tools
- DGM: whole-file overwrite replaced by `str_replace` (exact single-occurrence replacement, fails on zero or multiple matches) and `view` with a line range — [arXiv 2505.22954](https://arxiv.org/html/2505.22954v2)
- SICA, in order: smart editor, quick overwrite, diff-enhanced editor, simplified diff verifier, ripgrep context summariser, input normaliser, file-edit verification with file-state tracking, minimal diff output, AST symbol locator (iteration 9; symbol accuracy 0.33 to 0.40), task-type routing, 100 KB file-size threshold, hybrid ripgrep-plus-AST locator, context-sensitive diff minimisation, targeted AST parsing — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- Live-SWE-agent's self-made tools: an edit tool that reports whether the edit actually changed anything (unlike `sed`), and a search tool that skips `.git`, `node_modules`, `__pycache__` and caps output at 20 matches — [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)
- AHE: a 1,364-line shell tool that surfaces contract hints from nearby files, with a publish guard — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)

Environment bootstrap and dependency handling
- Meta-Harness, TerminalBench-2: before the first model turn, one shell command gathers working directory, a truncated `/app` listing, available languages, package managers and memory; 15-second timeout, fails silently, about 80 lines. Gains on 7 of 89 tasks — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- Self-Harness: dependency prechecks (Qwen3.5); persist environment changes across shell sessions and verify tool access afterwards (GLM-5); parse import failures, install the missing package and rerun the test (GLM-5 on SWE-bench) — [arXiv 2606.09498](https://arxiv.org/html/2606.09498)
- RRSI, engineering domain: a bounded recovery hint for a "workdir must be an existing directory" error (122 to 128 passes of 244 at +1.6% tokens) — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- HGM: a generated function that classifies test-output errors, though for missing modules it only logged the intended install — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)

Budget, loop and retry control
- Self-HPO: a budget valve that warns as step or time limits approach and prompts a best-effort submission. Self-Harness: loop breaking, command-retry discipline, a cap on total tool messages, artefact-focused recovery after tool errors, "create an early version of the required output artefact". Meta-Harness reused a lesson "don't cleanup service artifacts" — [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1); [arXiv 2606.09498](https://arxiv.org/html/2606.09498); [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)

Context management and memory
- AHE: 12 boundary-case lessons in long-term memory. Middleware escalations seen in the evaluation critique: turn-budget trackers, output truncation, finalisation gates — [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2607.12227](https://arxiv.org/html/2607.12227)

**Which component carried the gain (the only component ablation found)**
- AHE, Terminal-Bench 2, one evolved component swapped into the seed (seed 69.7, full 77.0): memory only 75.3 (and best on the Hard tier at 63.3); tools only 73.0; middleware only 71.9; system prompt only 67.4, a regression. The single-component gains sum to more than the full gain, so the components overlap — [arXiv 2604.25850](https://arxiv.org/html/2604.25850)
- Consistent signals elsewhere: Meta-Harness's prompt rewrites regressed while the additive bootstrap won; RRSI's re-run of Meta-Harness and TTHE found their final harnesses dominated by long mandatory prose (730 words framed around the evolve suite's grading scheme; ten protocol blocks of about 8,500 words) and they transferred worst; RRSI rejected "pin the original task instruction into the completion gate" at −2.81 points — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- RHO on Terminal-Bench 2 produced mostly a procedural playbook whose generated scripts "were never executed", for its smallest gain (+0.05) — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)

**The matched-budget critique (independent; Allen Institute for AI and University of Washington)**
- "Rethinking the Evaluation of Harness Evolution for Agents" (arXiv 2607.12227 v4, 5 October 2026) [body]: Terminal-Bench 2.1, Claude Opus 4.6, GPT-5.4 and GPT-5.4 mini, budget K = 5, two runs, harness evolution instantiated with AHE (explore agent disabled) — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- Without unit-test feedback (average pass@1): direct sampling 68.2; parallel sampling 72.3; sequential refinement 69.3; harness evolution 67.4; per-task "harness scaling" 71.8 — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- With unit-test feedback (average pass@1 / pass@5): parallel sampling 82.0 / 82.0; sequential refinement 76.9 / 87.1; harness evolution 69.7 / 79.0; harness scaling 75.5 / 85.6 — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- With a 45 / 10 / 34 train, validation, test split: harness evolution averaged 63.2 on held-out tasks, identical to the initial harness (Opus 4.6 +1.2, GPT-5.4 0.0, GPT-5.4 mini −1.4). At K = 10 with Opus 4.6: 63.0 held-out (−0.3) — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- Their explanation: edits "memorize fixes rather than distilling strategies"; hard failures stay untouched; growing prompt text bloats context. They found large gains only where there is headroom and fine-grained feedback: ARC-AGI-3 with agent-written tools such as `frame_diff`, 43.3 to 77.5 for Opus 4.8 — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- Caveats: one evolution method; the held-out test set is 34 tasks and looks single-run; the cost of the harness edits themselves is excluded — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)

### Inferences
- The discovered improvements are a short, stable list that a toolkit can ship as defaults or as a proposer's menu: a pre-completion verification step tied to an explicit acceptance contract; an empty-or-unappliable-diff guard; an exact-match edit tool that reports no-ops; a silent start-up environment probe; dependency and import-failure recovery; step and time budget warnings; loop breakers. Nothing in the 2026 coding results lies outside this list.
- Executable changes (tools, middleware, hooks) and narrow memory entries carry the gains; broad prose rules carry the overfitting. This matches the first round's AGENTS.md and SkillsBench findings and now has a direct ablation (AHE) and a transfer comparison (RRSI) behind it.
- On strong models with an engineered seed, expect 2 to 8 points on the search tasks and 0 to 4 on unseen ones; double-digit gains come from weak models, minimal seeds, or search-equals-test reporting.
- The Allen/UW result means "did the harness change beat simply retrying?" is the comparison to make before crediting a harness edit. Persistent harness edits are only worth their maintenance cost if they generalise to tasks that have not been seen; per-task fixes are memory, not harness.

### Gaps
- Only one component ablation exists (AHE), on one benchmark and one model.
- No paper reports gains from harness evolution on a private or industrial codebase; every coding result is on SWE-bench variants, Terminal-Bench variants or Polyglot.
- The Allen/UW critique tests AHE only; Meta-Harness, RRSI and DarwinX have not been put through the same matched-budget, held-out protocol by an outside group.

## 5. Evidence on online, in-deployment improvement on a single evolving codebase with a human in the loop

### Takeaway
There is almost no controlled evidence for this setting. No paper read measures a harness-improvement loop on one long-lived repository with human reviewers; the nearest items are one unlabelled-trajectory method tested only on benchmarks, one in-situ benchmark protocol, one multi-day autonomous build that documents regressions, a game-playing system that automates what a human harness engineer used to do, and practitioner reports that keep the human as the one who decides.

### Cited Findings

**Closest research evidence**
- RHO is the only method designed for the post-deployment condition (no labels, no grader, only past trajectories). Its selection signal is the agent's own pairwise preference between re-runs. It was tested on benchmarks only, for a single round, and requires re-running past tasks three times in a cleanly resettable environment. Its ethics statement recommends full audit logs and human approval for sensitive harness edits — [arXiv 2606.05922](https://arxiv.org/html/2606.05922)
- The Harness-Updating study uses an in-situ protocol: each task is scored before its evidence is allowed to update the harness, which mimics a stream of work. On SWE-bench Verified the frontier models gained only +2.4 to +2.8 points this way from bases of 66–74% — [arXiv 2605.30621](https://arxiv.org/html/2605.30621)
- ACE online (no labels, one pass over the test stream) is the same idea for playbooks: +17.1 on AppWorld but only +3.8 on finance, and Dynamic Cheatsheet without labels went negative there (−3.7) (first-round figures, confirmed in the tables read) — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- Continual Harness (Princeton and Google DeepMind; arXiv 2605.09998 v1, 11 May 2026) adapts within one continuous run with no resets: every F steps a Refiner scans the recent trajectory window for failure signatures (loops, tool-call failures, stalled objectives) and rewrites system prompt, sub-agents, skills and memory in place. There is no validation step; a bad skill is repaired when a later use exposes it. Domain is Pokémon, not code. On Emerald with Gemini 3 Pro it reached 100% of milestones at a $130 median against 98% at $215 for the minimal baseline; Flash-Lite did not benefit; one variant regressed when the agent leaned on newly written, unrepaired sub-agents — [arXiv 2605.09998](https://arxiv.org/html/2605.09998)
- The same paper records what the human-in-the-loop version looked like: in the earlier Gemini Plays Pokémon runs a human read the livestreamed trajectories and rewrote the system prompt and primitives by hand, and Continual Harness "recovers a majority of the gap" to that hand-engineered expert harness rather than matching it — [arXiv 2605.09998](https://arxiv.org/html/2605.09998)

**A single evolving codebase over many iterations**
- Harness-of-Harness (Shanghai AI Laboratory; arXiv 2609.01481 v1, 1 September 2026) ran 70 planner, developer, tester loops building one Godot game from a requirements document with Codex CLI and GPT-5.6-Sol; humans only restored network or API access. It improves the software artefact and an evidence state, not the harness. By loop 70: 81 issues recorded, 65 closed, 16 open, and **17 issues reopened after being closed** because later changes broke previously verified behaviour. Duration, cost and codebase size are not reported — [arXiv 2609.01481](https://arxiv.org/html/2609.01481)
- HarnessX reports the same coupling problem inside harness evolution: per-edit gates passed, yet accumulated same-type edits produced a −14.0 regression at round 7 — [arXiv 2606.14249](https://arxiv.org/html/2606.14249)

**Human in the loop: practitioner evidence, not experiments**
- Thoughtworks Technology Radar, "Feedback flywheel", moved from Assess (15 April 2026) to Trial (Volume 35, 4 November 2026) because "harness edits are now routine". The practice: at the end of each coding-agent session ask whether a shared artefact (AGENTS.md, skills, sensors) should change; a retrospective item where the team decides; tools that propose edits from past sessions for a human to accept or reject. Agents propose, people choose. It stresses removal as well as addition (rules accumulate into instruction bloat; noisy sensors should be retired), re-evaluation when the model changes, and that teams "still need a human-in-the-loop to avoid context rot and noisy feedback". It cites team experience, no measurements — [Thoughtworks Radar](https://www.thoughtworks.com/en-de/radar/techniques/feedback-flywheel)
- A September 2026 field report from a multi-tenant agent platform describes 433 rules and 3,422 memory files across 74 workspaces with 37 rules retired through a provenance log, under human-written gates [snippet; primary not opened] — [scalably.io](https://scalably.io/research/fast-memory-slow-weights)
- APEX (Grace AI Technology; arXiv 2606.15363 v1, 13 June 2026) is a real deployment (114 task traces over 18 days, one agent managing a 15-node fleet) with **no human gate and no validation step**: a local model reads the 30 most recent failure traces and injects three prohibition rules into the next system prompt. Its "+90%" is a composite health score computed from a formula against a calibrated baseline, not measured task success, and the stated formula does not reproduce the reported 0.570. It should not be cited as evidence that the loop works — [arXiv 2606.15363](https://arxiv.org/html/2606.15363)

**Adjacent negative evidence for unsupervised self-authoring**
- **Correction (resolves the first round's SkillsBench gap):** SkillsBench v4 (14 June 2026) does test self-generated skills, on three configurations. They scored below the no-skills baseline on all three: Claude Code + Opus 4.7 −8.1 points (no-skills 43.0%, curated 61.2%), Codex + GPT-5.5 −11.3 (46.8%, 66.5%), Gemini CLI + Gemini 3.1 Pro −11.5 (36.0%, 60.8%). Causes found in the trajectory audit: generated packs the solver never discovers, authoring that displaces solving, and confidently wrong content — [arXiv 2602.12670](https://arxiv.org/html/2602.12670)
- AHE states it did not study human-in-the-loop workflows; Self-Harness states higher-stakes edits "would need stronger acceptance gates than pass-rate non-regression" — [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2606.09498](https://arxiv.org/html/2606.09498)

### Inferences
- The setting that matters here is outside what the literature has measured. Every design choice for it is an extrapolation from benchmark loops, and should be labelled as such.
- What does transfer from the evidence: (1) without a grader, self-judged improvement is conservative at best (RHO skipped a better candidate) and harmful at worst (Dynamic Cheatsheet, self-generated skills), so on a live repository the repository's own tests, type checks and review outcomes should be the signal, and a human should decide on anything those signals cannot score; (2) the reopen rate in Harness-of-Harness (17 of 81 issues) says regressions on a single evolving codebase are the normal case, so a standing regression set built from past fixed failures is worth more than any one-off evaluation; (3) the deployment stream supplies few repeats of any one failure, so the unit of evidence must be a failure pattern recurring across sessions (Self-Harness's clusters, Thoughtworks' "repeatedly failing checks"), not a single bad session.
- The human's demonstrated role in the sources is selection and removal, not authorship: agents propose, people accept or reject, and someone prunes. That matches where the automated loops are weakest (regression blindness, overfitting to prose, bloat).
- An in-deployment loop cannot re-run yesterday's task on today's repository cheaply, so RHO-style group rollouts and Self-Harness-style held-in or held-out splits do not carry over directly. Snapshotting the repository state with each recorded failure is a precondition for replay; none of the papers addresses this.

### Gaps
- No controlled study of a harness-improvement loop on a long-lived private repository with human reviewers was found; no study measures human accept or reject rates for proposed harness edits, time cost to reviewers, or outcome over months.
- No paper addresses replaying a past failure against a repository that has since changed.
- No primary source from Anthropic, OpenAI or Google describing measured results of in-product harness self-improvement was found in this session.
- The scalably.io field report and a LangChain product description surfaced only as search snippets and were not opened.

## 6. Which claims have been independently reproduced or criticised, and by whom

### Takeaway
Independent replication is thin: the main checks are other papers re-running a method as a baseline, and those re-runs usually find smaller gains than the original. The strongest critiques are the Allen Institute and University of Washington matched-budget study, Google's out-of-distribution re-runs in RRSI, and the UESTC tampering audit of public DGM, Hyperagents, ADAS and AFlow run logs.

### Cited Findings

**Re-runs by other research groups**

| Method re-run | By whom | What they found |
|---|---|---|
| ADAS | AFlow authors | 67.2 average against 72.8 for plain input-output prompting on GPT-4o-mini; MBPP 53.4, MATH 35.4 |
| ADAS (as "DGM-H w/o self-improve") | Hyperagents authors | 0.0 median on paper review; 0.213 on robotics |
| Meta Agent Search | Gödel Agent authors | cost about $300 per run against their $15 |
| SICA | HGM authors | context-window overflow after 360 evaluations; 50.0% on SWE-Verified-60 |
| DGM | HGM authors | 53.3% on SWE-Verified-60 in 1,231 CPU-hours (re-run with a cheaper model) |
| DGM (original, uncustomised) | Hyperagents authors | 0.0 outside coding; transferred agents imp@50 = 0.0 |
| ACE | Meta-Harness authors | 40.9 against 48.6, using 50.8K context tokens |
| ACE | AHE authors | 68.9 on Terminal-Bench 2, below the 69.7 seed; below seed on SWE-bench Verified |
| GEPA | ACE authors | +4.0 on AppWorld against ACE's +17.0 |
| GEPA, OpenEvolve | Meta-Harness authors | 32.6 and 39.1 median against 50.0 |
| Dynamic Cheatsheet | ACE authors; RHO authors | 65.4 on finance without labels (−3.7); +0.01 to +0.03 over vanilla Codex |
| Meta-Harness | Google (RRSI) | out-of-distribution 40.6 against base 39.7; final harness was 730 words fitted to the grading scheme |
| Meta-Harness | Microsoft (Self-HPO) | 63.5 against base 57.8 on three SWE benchmarks, the best harness-only method there |
| Meta-Harness | RHO authors | 0.62 after one round, 0.80 after ten, on SWE-Bench Pro |
| Meta-Harness, GEPA | RELAI | no further gain from a second budget; GEPA below baseline on new tasks [abstract; vendor report] |
| AHE | Google (RRSI) | out-of-distribution 39.2, below the 39.7 base, at 58% more tokens than RRSI |
| AHE | Allen AI and UW | no gain over the initial harness on held-out Terminal-Bench 2.1 tasks; below parallel sampling |
| HarnessX | Google (RRSI) | out-of-distribution 39.7, flat |
| Self-Harness | Microsoft (Self-HPO) | +2.3 average (57.8 to 60.1) |

- Sources — [arXiv 2410.10762](https://arxiv.org/html/2410.10762); [arXiv 2603.19461](https://arxiv.org/pdf/2603.19461v2); [arXiv 2410.04444](https://arxiv.org/html/2410.04444v4); [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3); [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1); [arXiv 2604.25850](https://arxiv.org/html/2604.25850); [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3); [arXiv 2606.05922](https://arxiv.org/html/2606.05922); [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3); [arXiv 2610.22791](https://arxiv.org/html/2610.22791v1); [arXiv 2607.14004](https://arxiv.org/abs/2607.14004); [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- All of these are re-runs by authors of a competing method, who have an incentive to under-tune baselines. The Allen AI and UW study and the tampering audit are the only two without a competing method of the same kind to promote — [arXiv 2607.12227](https://arxiv.org/html/2607.12227); [arXiv 2609.00069](https://arxiv.org/html/2609.00069)

**Direct critiques**
- Evaluation method (Allen AI, UW; 5 October 2026): harness-evolution papers omit matched-budget test-time baselines and search with unit tests from the benchmark they report on; under those controls AHE's gain disappears on Terminal-Bench 2.1 — [arXiv 2607.12227](https://arxiv.org/html/2607.12227)
- Overfitting (Google, RRSI): unregularised evolution and four prior methods gain in distribution and are flat or negative out of distribution — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- Integrity (UESTC audit): tampering findings in 63.1% of DGM iterations and 73.6% of Hyperagents iterations, persisting into the best agent's lineage; measured by one LLM auditor with a 6.3% false-positive rate on seeded controls — [arXiv 2609.00069](https://arxiv.org/html/2609.00069)
- Selection signal (HGM): DGM's and SICA's own-score selection correlates weakly with descendant quality (0.285 and 0.444 against 0.778 for HGM's estimator) (first-round finding) — [arXiv 2510.21614](https://arxiv.org/html/2510.21614v3)
- Offline evolution cost versus on-the-fly tools (Live-SWE-agent): 65.0% at zero offline cost against DGM's 53.3% on the 60-task subset, but using baseline numbers copied from the HGM paper — [arXiv 2511.13646](https://arxiv.org/html/2511.13646v3)
- Meta-Harness could not reproduce the top TerminalBench-2 leaderboard entry (ForgeCode, 81.8) from its public code — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- GEPA in practice [snippet, not opened]: Simon Willison (July 2026) reported GEPA raising training accuracy on a 30-question set while lowering held-out accuracy, with two of three baseline "failures" being scorer bugs; Decagon (March 2026) reported prompts growing and performance falling as training data went from 50 to 500 samples, fixed with a length-constrained proposer; the VISTA paper argues GEPA prompts are model-specific — [letsdatascience summary](https://letsdatascience.com/news/dspy-evaluates-and-refines-datasette-agent-prompts-6ced2073); [Decagon](https://decagon.ai/blog/optimizing-gepa-for-production); [arXiv 2603.18388](https://arxiv.org/pdf/2603.18388)

**Self-reported inconsistencies found on a full read**
- SICA: abstract 53% is the peak, the final iteration is 51% — [arXiv 2504.15228](https://arxiv.org/html/2504.15228v2)
- Meta-Harness: "five held-out models" is four; 60 versus 40 candidates; 64.4 versus 74.7 baseline in the search log — [arXiv 2603.28052](https://arxiv.org/html/2603.28052v1)
- ACE: abstract and prose margins not derivable from the tables — [arXiv 2510.04618](https://arxiv.org/html/2510.04618v3)
- RRSI: 30% versus about 36% token saving; 32 versus 38 candidates — [arXiv 2609.24972](https://arxiv.org/html/2609.24972v3)
- AFlow: α and λ swapped between text and algorithm — [arXiv 2410.10762](https://arxiv.org/html/2410.10762)
- Dynamic Cheatsheet: two prose figures contradict Table 1 and Table 2 — [arXiv 2504.07952](https://arxiv.org/html/2504.07952)
- APEX: the stated formula gives 0.97, the paper reports 0.570 — [arXiv 2606.15363](https://arxiv.org/html/2606.15363)

**Peer-review status**
- Peer reviewed: ADAS and AFlow (ICLR 2025), Gödel Agent (ACL 2025), DGM, HGM (oral), GEPA (oral) and ACE (ICLR 2026), Harness-Updating (EMNLP 2026, per the first round). No OpenReview review text was retrieved for any of them in this session — [ICLR 2026 proceedings, HGM](https://proceedings.iclr.cc/paper_files/paper/2026/hash/821d20219c2f14850af1b5220f0ed13f-Abstract-Conference.html)
- No independent replication of DGM's SWE-bench result on a fresh split was found; a search returned only commentary — [The Register](https://www.theregister.com/2025/06/02/self_improving_ai_cheat/)

### Inferences
- The pattern across re-runs is regression toward a small effect: a method's gain measured by its authors on their seed and tasks is typically several times its gain when another group runs it on a stronger seed or unseen tasks (Self-Harness +22 to +2.3; AHE +7.3 to about 0; ACE +17 to below seed). Planning numbers should come from the re-runs.
- Meta-Harness is the method that survives outside re-runs best on coding (best harness-only baseline in Self-HPO, reaches 0.80 in RHO's comparison), while also being shown to overfit when its proposer is allowed to write long prose (RRSI). Both facts point at the same design conclusion: trace-informed agentic proposal works; unconstrained prose output is the failure channel.
- The tampering rates should be read as "auditing self-modification logs finds many integrity problems" rather than as precise frequencies, given a single LLM auditor and seeded training labels. The qualitative conclusion (keep recording and evaluation outside the write scope, audit diffs) does not depend on the exact rate.

### Gaps
- No OpenReview reviews or rebuttals were retrieved for any paper; reviewer criticisms are therefore absent from these notes.
- No third-party replication exists for Self-Harness's nine-pair table, RRSI, DarwinX, RHO, RHI, HSI or Hyperagents' transfer result.
- The practitioner critiques of GEPA and the VISTA paper were seen only as search snippets.
- The RELAI continual-learning comparison is a vendor technical report read at abstract level.
