## Multi-entity capture from free-form text

When the user pastes a block of unstructured content (a meeting transcript, an email, a LinkedIn bio), use the capture pipeline instead of chaining manual creates:

```
POST /api/hub/capture/structure   → returns proposals + relations
POST /api/hub/capture/execute     → commits (after user confirms)
```

The pipeline extracts multiple entities with their relations in one LLM call. Read **`capture.md`** for the full flow.
