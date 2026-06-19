// Global test setup — runs before any test file.
//
// Neutralise LLM/embedding API keys so the test suite NEVER makes a real network
// call, regardless of what's in the developer's shell. The validation detectors
// and embedding paths gate on these env vars; clearing them keeps every test
// deterministic and offline. Tests that need to exercise the LLM path mock it
// explicitly.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
