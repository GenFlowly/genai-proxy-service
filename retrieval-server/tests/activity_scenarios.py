"""Scripted turns for the activity recorder, and the golden logs they produce.

Each scenario is a timeline of hand-built LangGraph `astream_events` v2 events
on a fake clock. Running it through ActivityRecorder yields the activity log
written to tests/fixtures/activity/<name>.json; the component library and the
iOS app test their reducers against copies of those files, so these scenarios
are the shared contract. The numbers follow the design 6 boards.

Regenerate after a deliberate contract change:
    REGENERATE_ACTIVITY_FIXTURES=1 .venv/bin/python -m unittest tests.test_activity_recorder
"""
import json
import pathlib
from dataclasses import dataclass, field

from langchain_core.messages import AIMessageChunk

from activity import ActivityRecorder
from activity.schema import CALL_FINISHED_EVENT, TURN_COMPLETED, TURN_ERROR

FIXTURE_DIR = pathlib.Path(__file__).parent / "fixtures" / "activity"

MEMORY, AGENT, TOOLS, INPUT = "NODMEMORY01", "NODAGENT001", "NODTOOLS001", "NODINPUT001"
NODE_TYPES = {MEMORY: "MEMORY", AGENT: "RESPONSE_GENERATOR", TOOLS: "TOOL_EXECUTOR", INPUT: "HUMAN_INPUT"}
NODE_NAMES = {MEMORY: "Memory", AGENT: "Agent", TOOLS: "Tools", INPUT: "Ask the user"}
STREAMING = {AGENT}


class FakeClock:
    def __init__(self, start: float = 1000.0):
        self.t = start

    def __call__(self) -> float:
        return self.t


def _meta(node: str, nested: bool = False) -> dict:
    ns = f"{TOOLS}:task-1|subagent_generator:task-9" if nested else f"{node}:task"
    return {"langgraph_node": node, "langgraph_checkpoint_ns": ns}


def start(node: str, run: str, nested: bool = False) -> dict:
    return {"event": "on_chain_start", "name": node, "run_id": run, "metadata": _meta(node, nested), "data": {}}


def end(node: str, run: str, output: dict, nested: bool = False) -> dict:
    return {"event": "on_chain_end", "name": node, "run_id": run, "metadata": _meta(node, nested),
            "data": {"output": output}}


def stream(node: str, text: str, nested: bool = False) -> dict:
    return {"event": "on_chat_model_stream", "name": "ChatOpenAI", "run_id": "llm",
            "metadata": _meta(node, nested), "data": {"chunk": AIMessageChunk(content=text)}}


def calling(node: str, nested: bool = False) -> dict:
    """The first streamed piece of a tool call."""
    chunk = AIMessageChunk(content="", tool_call_chunks=[{"name": "web_search", "args": "", "id": "call", "index": 0}])
    return {"event": "on_chat_model_stream", "name": "ChatOpenAI", "run_id": "llm",
            "metadata": _meta(node, nested), "data": {"chunk": chunk}}


def call_done(node: str, facts: dict, nested: bool = False) -> dict:
    return {"event": "on_custom_event", "name": CALL_FINISHED_EVENT, "run_id": "custom",
            "metadata": _meta(node, nested), "data": facts}


def trace(prompt: str, response: str = "") -> list:
    return [{"node": "RESPONSE_GENERATOR", "prompt": prompt, "response": response}]


def tool_call(call_id: str, query: str, purpose: str, topic: str = "general") -> dict:
    args = {"purpose": purpose, "query": query}
    if topic != "general":
        args["topic"] = topic
    return {"id": call_id, "name": "web_search", "args": args}


def source(index: int, title: str, url: str, date: str = "") -> dict:
    domain = url.split("/")[2]
    entry = {"index": index, "title": title, "url": url, "favicon": f"https://{domain}/favicon.ico"}
    if date:
        entry["published_date"] = date
    return entry


def call_entry(call: dict, seq: int, mode: str, duration_ms: int, sources: list,
               excerpt: str = "", error=None, details=None) -> dict:
    entry = {
        "id": call["id"], "seq": seq, "name": call["name"], "args": call["args"], "mode": mode,
        "duration_ms": duration_ms,
        "result_count": None if error else len(sources),
        "result_excerpt": None if error else (excerpt or f"Web search results for '{call['args']['query']}'."),
        "sources": sources, "artifacts": [], "error": error,
    }
    if details:
        entry["details"] = details
    return entry


def facts_of(entry: dict) -> dict:
    """What the tool executor reports the moment one call finishes."""
    return {k: entry[k] for k in ("id", "seq", "name", "mode", "duration_ms", "result_count", "error")}


def tools_output(entries: list, budget: dict | None = None, all_sources: list | None = None) -> dict:
    trace_entry = {"node": "TOOL_EXECUTOR", "calls": entries}
    if budget:
        trace_entry["budget"] = budget
    out = {"trace": [trace_entry], "tool_calls": None, "generated_response": None}
    if all_sources:
        out["tool_sources"] = all_sources
    return out


CORE_MEMORIES = [
    "Works as a software engineer.",
    "Prefers free and open-source tools.",
    "Asked not to treat past topics as a chosen direction.",
    "Wants claims backed by measured data, not inference.",
    "Prefers short answers with the evidence linked.",
    "Is exploring ideas for a small software business.",
    "Has no interest in consumer social apps.",
    "Prefers bootstrapping over raising venture money.",
    "Can build web and iOS apps alone.",
    "Has limited time on weekday evenings.",
    "Prefers markets where buyers already pay for software.",
    "Distrusts vendor-funded market reports.",
    "Likes comparisons laid out as tables.",
    "Writes in US English.",
]
RECALLED_MEMORIES = [
    "Rejected three earlier wedge ideas for lacking buyer data.",
    "Asked last week which industries underuse their software budgets.",
]


def memory_output(core: list, recalled: list) -> dict:
    lines = ["## What you know about this user", "intro:"] + [f"- {m}" for m in core]
    if recalled:
        lines += ["", "## Possibly relevant background for this message", "intro:"] + [f"- {m}" for m in recalled]
    return {
        "memories_block": "\n".join(lines),
        "scratch": {"memories": "\n".join(lines), "memory_stats": {"core": len(core), "recalled": len(recalled)}},
    }


USER_PROMPT = "Those three wedges were guesses. Which of them actually have buyer data?"
REASON_1 = ("Those three wedges were inferences, not measured markets. I'm pulling actual "
            "adoption and funding data before naming anything.")
REASON_2 = ("The last pass was inference. I'm checking measured gaps — unused Medicare billing "
            "and similar hard numbers — and whether startups already own them.")
ANSWER = ("You're right to reject those. Two of the three had no buyer data, and \"no search "
          "results\" is not evidence of a gap. What the measured data does show: Chronic Care "
          "Management billing is used by under 5% of eligible practices [1], the unbilled dollars "
          "sit in practices with fewer than five physicians [3], and the two funded startups in "
          "that space sell to groups of ten or more [26] [27]. Legal aid has demand data [12] and "
          "labor-cost data [21] but no willingness-to-pay signal.")

R1 = [
    tool_call("call_a1", "US small business technology adoption by industry, Census ABS 2024-2025",
              "Find measured technology adoption by industry for small firms."),
    tool_call("call_a2", "industries lowest software spend highest labor cost small firms NAICS data",
              "Find industries that spend little on software but a lot on labor."),
    tool_call("call_a3", "best pre-seed funds for technology-driven startups 2026",
              "Check which investors fund this kind of small software business."),
]
R2 = [
    tool_call("call_b1", "Chronic Care Management software startups funding Series A TimeDoc ChartSpan ThoroughCare",
              "Check whether funded startups already own the CCM billing gap.", topic="news"),
    tool_call("call_b2", "unused CCM billing eligible practices percent",
              "Measure how much eligible CCM billing goes unused."),
    tool_call("call_b3", "ChartSpan ThoroughCare customers practice size",
              "See which practice sizes the funded vendors sell to."),
]

_R1_TITLES = [
    [("Evaluation of the Diffusion and Impact of the Chronic Care Management (CCM) Services", "https://www.cms.gov/priorities/innovation/data-and-reports/ccm-evaluation", "2023-06-01"),
     ("Connected Care Toolkit", "https://www.cms.gov/about-cms/agency-information/omh/connected-care-toolkit", ""),
     ("Chronic Care Management Reimbursement: Pitfalls & Potential", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9000001/", "2022-03-14"),
     ("Annual Business Survey: Technology Characteristics", "https://www.census.gov/programs-surveys/abs/data/tables.html", "2025-01-30"),
     ("Small Business Technology Adoption, 2024", "https://www.census.gov/library/stories/2025/small-business-tech.html", "2025-02-11"),
     ("Digital Adoption by Firm Size", "https://www.oecd.org/digital/sme/adoption-2024.htm", "2024-11-05"),
     ("Technology Use by Industry Tables", "https://www.census.gov/data/tables/2024/econ/abs/tech-use.html", "2024-12-02"),
     ("AI and Software Use Among Small Employers", "https://www.nfib.com/surveys/technology-2025/", "2025-04-18"),
     ("The State of Small Business Software", "https://www.sba.gov/advocacy/state-small-business-software", "2024-09-23")],
    [("Justice Gap Research", "https://www.lsc.gov/initiatives/justice-gap-research", "2024-04-25"),
     ("Labor Productivity by Detailed Industry", "https://www.bls.gov/productivity/tables/detailed-industries.htm", "2025-03-27"),
     ("Employer Costs for Employee Compensation", "https://www.bls.gov/news.release/ecec.toc.htm", "2025-06-13"),
     ("Information Technology Spending by Industry", "https://www.census.gov/programs-surveys/ictu.html", "2024-08-20"),
     ("Legal Services Industry Profile", "https://www.bls.gov/iag/tgs/iag5411.htm", "2025-02-28"),
     ("Small Law Firm Technology Survey", "https://www.americanbar.org/groups/law_practice/resources/tech-survey/", "2024-10-10"),
     ("Home Health Care Services Wages", "https://www.bls.gov/oes/current/naics4_621600.htm", "2025-04-02"),
     ("Productivity and Costs by Industry: Selected Service-Providing Industries", "https://www.bls.gov/news.release/prin2.toc.htm", "2025-05-15")],
    [("Pre-seed funds to know in 2026", "https://techcrunch.com/2026/01/12/pre-seed-funds-2026/", "2026-01-12"),
     ("The best pre-seed investors, ranked", "https://www.crunchbase.com/lists/pre-seed-investors-2026", "2026-02-03"),
     ("How pre-seed rounds changed in 2025", "https://www.axios.com/pro/2025/12/18/pre-seed-rounds", "2025-12-18"),
     ("Seed investing report Q4 2025", "https://pitchbook.com/news/reports/q4-2025-seed", "2026-01-20"),
     ("A guide to pre-seed fundraising", "https://www.ycombinator.com/library/pre-seed-guide", ""),
     ("Micro VC funds focused on vertical software", "https://www.signal.nfx.com/lists/vertical-software", "2025-11-30"),
     ("Who funds health-care software at pre-seed", "https://www.fiercehealthcare.com/health-tech/pre-seed-2026", "2026-01-28"),
     ("Pre-seed valuations by sector", "https://carta.com/data/pre-seed-valuations-2025/", "2025-12-05")],
]
_R2_TITLES = [
    [("ThoroughCare raises Series A to expand care-management platform", "https://www.thoroughcare.net/news/series-a", "2026-03-04"),
     ("ChartSpan Medical Technologies: customers and pricing", "https://www.chartspan.com/customers", "2026-01-15"),
     ("TimeDoc Health: funding, investors", "https://www.crunchbase.com/organization/timedoc-health", "2025-10-01"),
     ("Care-management startups draw new money", "https://www.fiercehealthcare.com/health-tech/ccm-funding-2026", "2026-02-20")],
    [("CCM uptake among eligible beneficiaries remains low", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9100002/", "2025-07-08"),
     ("Medicare Physician Fee Schedule: CCM utilization", "https://www.cms.gov/medicare/payment/fee-schedules/physician/ccm-utilization", "2025-11-01")],
    [],
]


def _numbered(groups: list, base: int) -> list:
    out, n = [], base
    for group in groups:
        rows = []
        for title, url, date in group:
            n += 1
            rows.append(source(n, title, url, date))
        out.append(rows)
    return out


R1_SOURCES = _numbered(_R1_TITLES, 0)
R2_SOURCES = _numbered(_R2_TITLES, 25)
ALL_SOURCES = [s for g in R1_SOURCES + R2_SOURCES for s in g]
CITED = [s for s in ALL_SOURCES if s["index"] in (1, 3, 12, 21, 26, 27)]

R1_ENTRIES = [
    call_entry(R1[0], 1, "run", 4600, R1_SOURCES[0]),
    call_entry(R1[1], 2, "run", 3900, R1_SOURCES[1]),
    call_entry(R1[2], 3, "run", 4200, R1_SOURCES[2]),
]
R2_ENTRIES = [
    call_entry(R2[0], 1, "run", 2400, R2_SOURCES[0]),
    call_entry(R2[1], 2, "run", 4600, R2_SOURCES[1]),
    call_entry(R2[2], 3, "run", 4900, R2_SOURCES[2], excerpt="No web results found for 'ChartSpan ThoroughCare customers practice size'."),
]


def _completed_timeline() -> list:
    return [
        (0.00, start(MEMORY, "m1")),
        (0.40, end(MEMORY, "m1", memory_output(CORE_MEMORIES, RECALLED_MEMORIES))),
        (0.40, start(AGENT, "a1")),
        (1.20, stream(AGENT, "Those three wedges were inferences, ")),
        (1.30, stream(AGENT, "not measured markets.")),
        (1.50, calling(AGENT)),
        (3.50, end(AGENT, "a1", {"generated_response": REASON_1, "tool_calls": R1,
                                 "trace": trace(USER_PROMPT, REASON_1)})),
        (3.50, start(TOOLS, "t1")),
        (7.60, call_done(TOOLS, facts_of(R1_ENTRIES[1]))),
        (7.90, call_done(TOOLS, facts_of(R1_ENTRIES[2]))),
        (8.30, call_done(TOOLS, facts_of(R1_ENTRIES[0]))),
        (8.30, end(TOOLS, "t1", tools_output(R1_ENTRIES, {"used": 3, "max": 6}, ALL_SOURCES[:25]))),
        (8.30, start(AGENT, "a2")),
        (9.10, stream(AGENT, "The last pass was inference.")),
        (9.40, calling(AGENT)),
        (11.20, end(AGENT, "a2", {"generated_response": REASON_2, "tool_calls": R2,
                                  "trace": trace(USER_PROMPT, REASON_2)})),
        (11.20, start(TOOLS, "t2")),
        (13.80, call_done(TOOLS, facts_of(R2_ENTRIES[0]))),
        (16.00, call_done(TOOLS, facts_of(R2_ENTRIES[1]))),
        (16.30, call_done(TOOLS, facts_of(R2_ENTRIES[2]))),
        (16.40, end(TOOLS, "t2", tools_output(R2_ENTRIES, {"used": 6, "max": 6}, ALL_SOURCES))),
        (16.40, start(AGENT, "a3")),
        (20.00, stream(AGENT, "You're right to reject those. ")),
        (20.10, stream(AGENT, "Two of the three had no buyer data.")),
        (21.00, stream(AGENT, ANSWER[65:])),
        (22.00, end(AGENT, "a3", {"generated_response": ANSWER, "trace": trace(USER_PROMPT, ANSWER)})),
    ]


# ----- denied searches: soft budget 3, hard cap 5 --------------------------------

D1 = [tool_call(f"call_d1{i}", q, p) for i, (q, p) in enumerate([
    ("open source CRM self-hosted 2026", "Find self-hosted CRMs that are actively maintained."),
    ("Twenty CRM release notes", "Check how active the leading open-source CRM is."),
    ("SuiteCRM vs EspoCRM comparison", "Compare the two older open-source CRMs."),
    ("open source CRM GitHub stars ranking", "Gauge community size."),
], start=1)]
D2 = [tool_call(f"call_d2{i}", q, p) for i, (q, p) in enumerate([
    ("Twenty CRM self-hosting requirements", "Check what self-hosting Twenty needs."),
    ("EspoCRM pricing extensions", "Check which EspoCRM features cost money."),
    ("SuiteCRM 8 performance", "Check whether SuiteCRM 8 is usable."),
], start=1)]
D3 = [tool_call(f"call_d3{i}", q, p) for i, (q, p) in enumerate([
    ("Twenty CRM docker compose memory", "Confirm Twenty's memory footprint."),
    ("EspoCRM docker image size", "Compare EspoCRM's footprint."),
], start=1)]

_D_SRC = [
    source(1, "Twenty: the open-source CRM", "https://github.com/twentyhq/twenty", "2026-10-30"),
    source(2, "Best open-source CRMs in 2026", "https://www.zdnet.com/article/best-open-source-crm-2026/", "2026-03-02"),
    source(3, "Twenty release notes", "https://twenty.com/releases", "2026-11-10"),
    source(4, "SuiteCRM vs EspoCRM", "https://www.g2.com/compare/suitecrm-vs-espocrm", ""),
    source(5, "Self-hosting Twenty", "https://twenty.com/developers/self-hosting", "2026-09-01"),
    source(6, "Twenty docker compose", "https://github.com/twentyhq/twenty/blob/main/packages/twenty-docker/docker-compose.yml", ""),
]
_SKIP = ("Web search skipped — this turn has already used 3 web search(es). Review the results you "
         "already have before searching again.")
_EXHAUSTED = ("Web search is no longer available this turn: the per-message search limit (5) has been "
              "reached. Do not call web_search again.")
DENIED_R1 = [
    call_entry(D1[0], 1, "run", 2100, [_D_SRC[0], _D_SRC[1]]),
    call_entry(D1[1], 2, "run", 1800, [_D_SRC[2]]),
    call_entry(D1[2], 3, "run", 2300, [_D_SRC[3]]),
    call_entry(D1[3], 4, "skip", 0, [], excerpt=_SKIP),
]
DENIED_R2 = [
    call_entry(D2[0], 1, "note", 1900, [_D_SRC[4]]),
    call_entry(D2[1], 2, "skip", 0, [], excerpt=_SKIP.replace("3 web", "4 web")),
    call_entry(D2[2], 3, "skip", 0, [], excerpt=_SKIP.replace("3 web", "4 web")),
]
DENIED_R3 = [
    call_entry(D3[0], 1, "note", 1700, [_D_SRC[5]]),
    call_entry(D3[1], 2, "exhausted", 0, [], excerpt=_EXHAUSTED),
]


def _denied_timeline() -> list:
    crm_q = "Which open-source CRM can I self-host on a small VPS?"
    return [
        (0.00, start(MEMORY, "m1")),
        (0.20, end(MEMORY, "m1", memory_output(CORE_MEMORIES[:3], []))),
        (0.20, start(AGENT, "a1")),
        (1.10, calling(AGENT)),
        (2.00, end(AGENT, "a1", {"generated_response": "", "tool_calls": D1, "trace": trace(crm_q)})),
        (2.00, start(TOOLS, "t1")),
        (2.00, call_done(TOOLS, facts_of(DENIED_R1[3]))),
        (3.80, call_done(TOOLS, facts_of(DENIED_R1[1]))),
        (4.10, call_done(TOOLS, facts_of(DENIED_R1[0]))),
        (4.30, call_done(TOOLS, facts_of(DENIED_R1[2]))),
        (4.40, end(TOOLS, "t1", tools_output(DENIED_R1, {"used": 3, "max": 5}, _D_SRC[:4]))),
        (4.40, start(AGENT, "a2")),
        (5.30, calling(AGENT)),
        (6.10, end(AGENT, "a2", {"generated_response": "I need the self-hosting requirements next.",
                                 "tool_calls": D2, "trace": trace(crm_q)})),
        (6.10, start(TOOLS, "t2")),
        (6.10, call_done(TOOLS, facts_of(DENIED_R2[1]))),
        (6.10, call_done(TOOLS, facts_of(DENIED_R2[2]))),
        (8.00, call_done(TOOLS, facts_of(DENIED_R2[0]))),
        (8.10, end(TOOLS, "t2", tools_output(DENIED_R2, {"used": 4, "max": 5}, _D_SRC[:5]))),
        (8.10, start(AGENT, "a3")),
        (8.90, calling(AGENT)),
        (9.40, end(AGENT, "a3", {"generated_response": "", "tool_calls": D3, "trace": trace(crm_q)})),
        (9.40, start(TOOLS, "t3")),
        (9.40, call_done(TOOLS, facts_of(DENIED_R3[1]))),
        (11.10, call_done(TOOLS, facts_of(DENIED_R3[0]))),
        (11.20, end(TOOLS, "t3", tools_output(DENIED_R3, {"used": 5, "max": 5}, _D_SRC))),
        (11.20, start(AGENT, "a4")),
        (12.60, stream(AGENT, "Twenty is the one to try first [1]")),
        (14.00, end(AGENT, "a4", {"generated_response": "Twenty is the one to try first [1] [5].",
                                  "trace": trace(crm_q, "Twenty is the one to try first [1] [5].")})),
    ]


# ----- error: a failing call, then the provider fails the next round -------------

E1 = [tool_call("call_e1", "Medicare CCM eligible practices count 2025", "Count eligible practices."),
      tool_call("call_e2", "CCM billing code 99490 rate 2026", "Check the current payment rate.")]
ERROR_R1 = [
    call_entry(E1[0], 1, "run", 1500, [source(1, "CCM eligibility", "https://www.cms.gov/ccm-eligibility", "2025-05-01")]),
    call_entry(E1[1], 2, "run", 900, [], error="TimeoutError: search provider did not answer within 30s"),
]


def _error_timeline() -> list:
    q = "How many practices could bill CCM today?"
    return [
        (0.00, start(MEMORY, "m1")),
        (0.30, end(MEMORY, "m1", {})),
        (0.30, start(AGENT, "a1")),
        (1.20, calling(AGENT)),
        (1.90, end(AGENT, "a1", {"generated_response": "Two numbers decide this: eligible practices and the rate.",
                                 "tool_calls": E1, "trace": trace(q)})),
        (1.90, start(TOOLS, "t1")),
        (2.80, call_done(TOOLS, facts_of(ERROR_R1[1]))),
        (3.40, call_done(TOOLS, facts_of(ERROR_R1[0]))),
        (3.50, end(TOOLS, "t1", tools_output(ERROR_R1, {"used": 2, "max": 5}, ERROR_R1[0]["sources"]))),
        (3.50, start(AGENT, "a2")),
    ]


# ----- subagent: a spawned agent whose own graph events must not become steps -----

S1 = [{"id": "call_s1", "name": "spawn_agent",
       "args": {"purpose": "Compare the two funded CCM vendors on price and practice size.",
                "prompt": "Compare ChartSpan and ThoroughCare: pricing model, minimum practice size, "
                          "and who their typical customer is. Cite sources."}}]
_S_SRC = [source(1, "ChartSpan Medical Technologies: customers and pricing", "https://www.chartspan.com/customers", "2026-01-15"),
          source(2, "ThoroughCare pricing", "https://www.thoroughcare.net/pricing", "2026-02-01")]
SUB_ENTRY = call_entry(S1[0], 1, "run", 9400, _S_SRC,
                       excerpt="ChartSpan sells a done-for-you service to groups of 10+ physicians [1]; "
                               "ThoroughCare licenses software per practice [2].",
                       details={"subagent": "general", "subagent_trace": [
                           {"node": "RESPONSE_GENERATOR", "prompt": "Compare ChartSpan and ThoroughCare", "response": ""},
                           {"node": "TOOL_EXECUTOR", "calls": [{"name": "web_search", "args": {"query": "ChartSpan pricing"}}]},
                       ]})
SUB_ENTRY["result_count"] = 2


def _subagent_timeline() -> list:
    q = "Which of the two CCM vendors would sell to a three-doctor practice?"
    sub_call = tool_call("call_child1", "ChartSpan pricing", "child purpose")
    return [
        (0.00, start(MEMORY, "m1")),
        (0.30, end(MEMORY, "m1", memory_output(CORE_MEMORIES[:2], RECALLED_MEMORIES[:1]))),
        (0.30, start(AGENT, "a1")),
        (1.60, calling(AGENT)),
        (2.10, end(AGENT, "a1", {"generated_response": "This needs a side-by-side, so I'll delegate the comparison.",
                                 "tool_calls": S1, "trace": trace(q)})),
        (2.10, start(TOOLS, "t1")),
        (2.20, start("subagent_generator", "c1", nested=True)),
        (3.00, stream("subagent_generator", "Searching vendor pages.", nested=True)),
        (3.20, calling("subagent_generator", nested=True)),
        (3.40, end("subagent_generator", "c1", {"tool_calls": [sub_call]}, nested=True)),
        (3.40, start("subagent_tools", "c2", nested=True)),
        (5.00, call_done("subagent_tools", facts_of(call_entry(sub_call, 1, "run", 1600, [])), nested=True)),
        (5.10, end("subagent_tools", "c2", tools_output([]), nested=True)),
        (11.50, call_done(TOOLS, facts_of(SUB_ENTRY))),
        (11.50, end(TOOLS, "t1", tools_output([SUB_ENTRY], None, _S_SRC))),
        (11.50, start(AGENT, "a2")),
        (13.00, stream(AGENT, "ThoroughCare.")),
        (14.20, end(AGENT, "a2", {"generated_response": "ThoroughCare would [2]; ChartSpan wants 10+ physicians [1].",
                                  "trace": trace(q)})),
    ]


def _memory_only_timeline() -> list:
    q = "Give me a one-line summary of what you know about my preferences."
    answer = "You like open-source tools, measured evidence, and short answers."
    return [
        (0.00, start(MEMORY, "m1")),
        (0.20, end(MEMORY, "m1", memory_output(CORE_MEMORIES[1:3], []))),
        (0.20, start(AGENT, "a1")),
        (0.80, stream(AGENT, "You like open-source tools, ")),
        (2.10, end(AGENT, "a1", {"generated_response": answer, "trace": trace(q, answer)})),
    ]


def _stopped_timeline() -> list:
    return [e for e in _completed_timeline() if e[0] <= 7.9]


@dataclass
class Scenario:
    name: str
    description: str
    timeline: list
    end_at: float | None
    outcome: str | None
    web_sources: list = field(default_factory=list)
    cited: list | None = None


SCENARIOS = [
    Scenario("completed_six_searches", "Design 6 done boards: two search rounds, 22 s, 31 sources, 6 cited.",
             _completed_timeline(), 22.00, TURN_COMPLETED, CITED, [s["index"] for s in CITED]),
    Scenario("live_mid_turn", "Design 6 live board: the same turn at 14.3 s, second search round running.",
             [e for e in _completed_timeline() if e[0] <= 14.3], None, None, ALL_SOURCES[:25]),
    Scenario("denied_searches", "Soft budget 3, hard cap 5: run, note, skip and exhausted calls.",
             _denied_timeline(), 14.00, TURN_COMPLETED, [_D_SRC[0], _D_SRC[4]], [1, 5]),
    Scenario("error_turn", "A call fails, then the provider fails the next round; the turn ends in error.",
             _error_timeline(), 4.20, TURN_ERROR, ERROR_R1[0]["sources"]),
    Scenario("subagent_call", "A spawn_agent call; the child graph's events never become steps.",
             _subagent_timeline(), 14.20, TURN_COMPLETED, _S_SRC, [1, 2]),
    Scenario("memory_only", "No tools: memory, then the answer.", _memory_only_timeline(), 2.10, TURN_COMPLETED, []),
    Scenario("stopped_turn", "The user pressed Stop while the first search round ran; no turn.end.",
             _stopped_timeline(), None, None, []),
]


def run(scenario: Scenario) -> list:
    clock = FakeClock()
    recorder = ActivityRecorder(node_type_map=NODE_TYPES, node_name_map=NODE_NAMES,
                                streaming_nodes=STREAMING, started_at=clock.t, clock=clock)
    base = clock.t
    events: list = []
    for t, event in scenario.timeline:
        clock.t = base + t
        events.extend(recorder.observe(event))
    if scenario.outcome is not None:
        clock.t = base + scenario.end_at
        if scenario.cited is not None:
            recorder.cite(scenario.cited)
        events.extend(recorder.finish(scenario.outcome))
    return events


def fixture(scenario: Scenario) -> dict:
    return {
        "name": scenario.name,
        "description": scenario.description,
        "live": scenario.outcome is None and scenario.name != "stopped_turn",
        "stop_reason": "cancelled" if scenario.name == "stopped_turn" else None,
        "events": run(scenario),
        "web_sources": scenario.web_sources,
    }


def write_all() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for scenario in SCENARIOS:
        path = FIXTURE_DIR / f"{scenario.name}.json"
        path.write_text(json.dumps(fixture(scenario), indent=2, ensure_ascii=False) + "\n")
