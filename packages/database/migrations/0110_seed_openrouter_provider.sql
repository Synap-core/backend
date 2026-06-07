-- Seed default AI provider: OpenRouter with DeepSeek V4 Flash as the balanced model.
-- ON CONFLICT DO NOTHING — safe to run on pods that already configured providers via admin UI.
INSERT INTO ai_providers (
  id,
  provider_id,
  name,
  base_url,
  api_key_env_var,
  enabled,
  priority,
  tags,
  models,
  rate_limit,
  metadata,
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  'openrouter',
  'OpenRouter',
  'https://openrouter.ai/api/v1',
  'OPENROUTER_API_KEY',
  true,
  1,
  '["cloud","aggregator"]',
  '[
    {"id":"deepseek/deepseek-v4-flash:free","tier":"balanced","contextWindow":1000000},
    {"id":"deepseek/deepseek-v4-flash:free","tier":"free","contextWindow":1000000},
    {"id":"nvidia/nemotron-3-super-120b-a12b:free","tier":"advanced","contextWindow":1000000},
    {"id":"openai/gpt-oss-20b:free","tier":"complex","contextWindow":131072}
  ]',
  '{"rpm":60}',
  '{}',
  now(),
  now()
)
ON CONFLICT (provider_id) DO NOTHING;
