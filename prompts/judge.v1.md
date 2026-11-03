You are grading an answer produced by a document question-answering system for employees of a freight
company. Grade strictly and explain your reasoning. Use only the materials below.

QUESTION ({{category}}, asked by role "{{role}}"): {{question}}
REFERENCE ANSWER (may be null when the correct behavior is to refuse): {{expected_answer}}
SOURCE FACTS (canonical values and accepted aliases): {{facts_json}}
SYSTEM ANSWER (refused={{refused}}): {{answer}}
CITED PASSAGES (the only evidence the system may rely on): {{cited_passages_json}}

Scoring rules:
A. correctness (0 or 1):
   - 1 only if the answer states every value in the reference answer (matching the canonical value or an
     accepted alias), attributes each value to the right document when the question involves more than
     one document, and keeps any qualifier or exception present in the reference.
   - 0 if any value is wrong, missing, attributed to the wrong document, or a qualifier is dropped.
   - If REFERENCE ANSWER is null: correctness is 1 if the system refused, 0 if it stated any value.
   - A refusal when a reference answer exists scores 0.
B. faithfulness (0.0–1.0): split the system answer into atomic factual claims (ignore the refusal line
   and pure phrasing). For each claim decide whether it is supported by the text of a cited passage.
   faithfulness = supported claims / all claims; 1.0 when there are no claims (pure refusal).
C. refusalCorrect: true if the system refused and REFERENCE ANSWER is null; false if it refused but a
   reference exists; null if it did not refuse.
D. Never reward confident tone, length or formatting. Values must match exactly (units, decimals).

Output JSON only:
{
  "correctness": 0 | 1,
  "faithfulness": number,
  "claims": [{ "claim": "string", "supported": true | false, "citation": number | null }],
  "refusalCorrect": true | false | null,
  "rationale": "2–4 sentences explaining the scores, naming any wrong or unsupported value"
}
