"""One chat completion call to Sarvam. Run: python3 sarvam_hello.py"""

import os
from pathlib import Path

from sarvamai import SarvamAI

# Load .env into the environment (no extra dependency).
for line in (Path(__file__).parent / ".env").read_text().splitlines():
    key, sep, value = line.strip().partition("=")
    if sep and not key.startswith("#"):
        os.environ.setdefault(key, value)

api_key = os.environ.get("SARVAM_API_KEY")
if not api_key:
    raise SystemExit("SARVAM_API_KEY is empty. Paste your key into .env first.")

client = SarvamAI(api_subscription_key=api_key)
response = client.chat.completions(
    model="sarvam-105b-conversations",
    messages=[{"role": "user", "content": "Say hello to a Snapdeal seller in one short sentence."}],
)
print(response.choices[0].message.content)
