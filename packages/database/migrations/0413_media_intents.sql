-- 0413 — transcribe_media and download_media intents; edit_video's words
--
-- What a capability DOES is a row, not a TypeScript union (0283). The media
-- tools that run on the person's computer (media-transcribe, media-download,
-- media-ffmpeg, media-matte) declared no intent (`provides: []`), so no
-- intent door could name them: "transcribe this video" found no tool
-- (audit 732371eb §4, finding 92708a1e).
--
-- Two kinds of work had no seat:
--   transcribe_media  turn speech in a video or audio file into a timed
--                     transcript (media-transcribe: whisper on the computer).
--   download_media    save a video or audio file from a web page onto the
--                     computer (media-download: yt-dlp).
-- Cutting a range, reframing, exporting and cutting a person out are
-- edit_video (0370, decision ac1ba2b6: "cut out a person, remove a
-- background, trim or reframe"); media-ffmpeg and media-matte declare it. A
-- seat per ffmpeg recipe (cut_video, reframe_video, export_video,
-- matte_video) would split one kind of work four ways, and a capability's
-- guide declares ONE intent.
--
-- EFFECT `act`, like edit_video and run_external_job: the work runs a job
-- on the person's computer and, for a download, reaches the web, so a pod
-- app's run of it is always proposed (`appRunMustPropose`). No input shape
-- (`input_schema` NULL): a pod app cannot ask for either yet.
--
-- edit_video's synonyms gain the words people use for the ffmpeg side of it
-- ("cut a clip", "reframe to vertical"): appended once, never duplicated,
-- never replacing a synonym a pod already has.
--
-- Post-seed rows (REGISTERED_EXTRAS), like 0284, 0314, 0329, 0360 and 0370.
-- The table exists (0283, and 0000_baseline_schema.sql on a fresh install).

INSERT INTO "capability_intents" ("slug", "effect", "statement", "synonyms")
VALUES
  ('transcribe_media', 'act', 'Turn the speech in a video or audio file into a timed transcript and subtitles.',
   ARRAY['transcribe', 'transcript', 'subtitles', 'captions', 'speech to text', 'word timings']),
  ('download_media', 'act', 'Save a video or audio file from a web page, such as YouTube, onto a computer.',
   ARRAY['download video', 'save video', 'youtube', 'download audio', 'rip a video'])
ON CONFLICT ("slug") DO NOTHING;

UPDATE "capability_intents"
SET "synonyms" = "synonyms" || ARRAY(
  SELECT w FROM unnest(ARRAY[
    'cut a clip', 'keep a range', 'reframe to vertical', 'resize video',
    'crop video', 'export video', 'shorts'
  ]) AS w
  WHERE NOT w = ANY ("synonyms")
)
WHERE "slug" = 'edit_video';
