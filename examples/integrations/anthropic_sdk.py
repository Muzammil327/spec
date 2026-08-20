"""
Record every Anthropic SDK call as a Context Passport.

The whole integration is the make_passport() call in _record(). Everything
else in this file is either the ordinary Anthropic SDK call you were already
making, or the demonstration harness.

    pip install anthropic context-passport
    export ANTHROPIC_API_KEY=sk-ant-...
    python anthropic_sdk.py

Run it with --offline to exercise the passport logic without an API key or a
network call, which is what CI does:

    python anthropic_sdk.py --offline

Why chain them: any single record proves only that someone wrote a record.
Linking each passport to its parent by hash means a later edit to step 1
invalidates every step after it, so the tampering is detectable rather than
merely discouraged.
"""

from __future__ import annotations

import os
import sys

from context_passport import make_passport, verify_chain

MODEL = "claude-sonnet-5"
TRACE = "trace_anthropic_sdk_demo"

chain: list[dict] = []


def _record(prompt: str, answer: str, model: str, role: str) -> dict:
    """Append one passport to the chain, linked to whatever came before it."""
    passport = make_passport(
        agent_id="anthropic-sdk-demo",
        agent_name="Claude",
        payload={"input": prompt, "output": answer},
        parent=chain[-1] if chain else None,
        role=role,
        provider="anthropic",
        model=model,
        trace_id=TRACE,
    )
    chain.append(passport)
    return passport


def ask(client, prompt: str, *, role: str = "assistant") -> str:
    response = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    answer = "".join(block.text for block in response.content if block.type == "text")
    _record(prompt, answer, response.model, role)
    return answer


# The offline path exists so this file is testable. It substitutes a canned
# answer for the API call and leaves the passport logic completely untouched.
def ask_offline(prompt: str, *, role: str = "assistant") -> str:
    answer = f"(offline stub answer for: {prompt})"
    _record(prompt, answer, MODEL, role)
    return answer


def main() -> int:
    offline = "--offline" in sys.argv

    steps = [
        ("Summarise the refund policy for order 1247.", "analyst"),
        ("Given that policy, is a refund owed on order 1247?", "reviewer"),
        ("Draft the customer message for that decision.", "drafter"),
    ]

    if offline:
        for prompt, role in steps:
            ask_offline(prompt, role=role)
    else:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("ANTHROPIC_API_KEY is not set. Use --offline to run without it.")
            return 2
        import anthropic

        client = anthropic.Anthropic()
        for prompt, role in steps:
            ask(client, prompt, role=role)

    print(f"\nSealed {len(chain)} steps into one chain (trace {TRACE}).")
    for i, p in enumerate(chain):
        print(f"  {i}  {p['id']}  {p['created_by']['role']:<9} {p['integrity']['integrity_hash'][:23]}...")

    print(f"\nverify_chain -> {verify_chain(chain)}")

    # Tamper with the first record and verify again. This is the only claim
    # that matters, so it is worth showing rather than asserting.
    chain[0]["payload"]["output"] = "Refund is NOT owed."
    print(f"after editing step 0's output -> {verify_chain(chain)}")
    print("\nThe edit is detectable because step 1 committed to step 0's hash.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
