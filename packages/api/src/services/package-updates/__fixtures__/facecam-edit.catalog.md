# Face-camera editing

Raw face-camera or screen+camera footage → a finished cut. The recording is the authority for what was said: remove what failed, never invent speech.

## Hard rules

- Never generate the person: no lip-sync, avatar, face swap or synthetic voice of the speaker unless the user explicitly asks.
- The person may edit the project in HyperFrames Studio at any time: build on their edits, never overwrite them (§4).
- Never cut inside a word. Every cut edge snaps to a word boundary from a word-level transcript.
- Confirm the cut strategy in plain words before touching the timeline. Render the final only after one human review.
- Revisions change only what was flagged.

## 1. Recall and set up

1. `synap_ask` for the brand kit (palette, caption font, lower-third template) and any approved `content-composition` to reuse.
2. Record with Cap (separate camera, screen, mic tracks); keep originals untouched.
3. `ffprobe` every source. Pick the delivery frame grid once (default 30 fps; 1080x1920 or 1920x1080) and keep it everywhere.
4. **One project per video run: `edit/`.** It lives in the run's work folder, `~/synap-work/<run session id>/edit` (the folder `synap worker` gives the run): `HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes init edit --non-interactive --skip-transcribe --resolution <portrait|landscape|square>`, the takes copied into `edit/media/`. A variable frame rate take is made constant once (§6, step 1: `media/take-cfr.mp4`) and the project uses that copy. Every pass happens in this project and every command below runs from `edit/`.
5. **Start Studio and record its address.** `npx hyperframes preview --background --port <a free port, from 3002 up>`; check that `http://localhost:<port>/#project/edit` answers HTTP 200, then record it on the run as an outcome: `{ key: "studio", kind: "link", label: "HyperFrames Studio", required: false, ref: { url: "http://localhost:<port>/#project/edit" } }`. Content Studio draws it as "Open in HyperFrames Studio". Studio hot-reloads, so the person watches each pass as you write it. When the run leaves Draft or stops: `npx hyperframes preview --stop` and `retireOutput: "studio"`. Back at Draft (Review sent it back): start it again and record the new address.

## 2. Transcribe (word level)

- Word-level, verbatim ASR only: fillers and false starts stay in the text (they are the signal); phrase/SRT output loses the gaps you cut on.
- One word-level ASR pass per source (`npx hyperframes transcribe <file> --engine parakeet`, or media-use's `transcribe.mjs`), only when the pod's transcript (below) has no word timings yet. Cache per source; never re-transcribe.
- The pod keeps a take's transcript as ONE `content-asset` (Kind `script`, File ID = the take's file): its body holds the readable text under a `## Transcript` heading, then a `## Words` heading followed by exactly one ```json block of `[{"text","start","end"}]` in seconds (`[]` until the precise pass fills it). Find it before transcribing; if it exists, reuse it and only fill the word timings; if not, create it and link it to the take's file with `references`. Never a separate document.
- Build a reading view: one line per phrase, `[start-end] text`, breaking on any silence of 0.5 s or more.

## 3. Plan cuts on the transcript (semantic first)

Three passes, in this order:

1. **Semantic.** Remove misspeaks, failed starts, repeated takes, production chatter ("wait, again"). Keep the last complete, correct take by default; keep deliberate emphasis and rhetorical self-correction. Remove a filler only when context shows it is a standalone filler, not part of a word or a meaningful pause.
2. **Pauses.** Remove dead air and restart preparation, including pauses inside kept phrases. Silence guide: 400 ms or more = clean cut target; 150-400 ms = usable after a visual check; under 150 ms = mid-phrase, do not cut. For a dB scan, look at -30, -35 and -40 dB with a 0.45 s minimum duration; a scan reports intervals, it does not authorise edits. Leave ambiguous breaths or possibly quiet words for the user to hear.
3. **Edges.** Only after 1 and 2 are applied, tighten each kept clip to the real sound: first and last sustained activity on the louder channel (measured in 10 ms windows), keep one frame of margin, and back off to lower-level tails rather than clipping a decaying word.

**Invisible cuts (picture continuity).** A cut the viewer notices is a failed cut (founder, 29 Oct). A cut that sits in a pause may slide inside that pause without touching speech, so put each edge where the face matches across it:
- Score every out/in frame pair inside the pause: face position and size (a face detector), plus the grey-level difference of the face crop. Take the pair with the smallest jump, with a small cost for each extra second of silence kept (about 0.25 per second) so the pause does not grow back, and still remove at least 0.25 s.
- A head turn inside the pause disappears with the cut: leave on the frame before the turn and come back on a frame already facing the camera, or the reverse. Never cut from mid-turn to facing the camera.
- Never move an edge into speech, and never drop a word to gain continuity. When no pair matches (a large jump remains), keep the cut and flag it: a punch-in of about 110% on the incoming side hides it, or the user decides.
- Report each cut's jump before and after. Pilot, 29 Oct (take b36227cd, 13 cuts): the mean jump fell from 0.59 to 0.29, for 4 s more runtime.

Padding: 30-200 ms working window around every kept word (ASR drifts 50-100 ms). A good default is 50 ms before the first kept word and 80 ms after the last; tighter for punchy social, looser for calm explainers. Hand-offs between speakers: 400-600 ms of air. Extend past laughs; the reaction is the beat.

Write the plan as `{source, start, end, quote, reason}` ranges, state the runtime, show the user a short strategy, and wait for confirmation. In Produce Content this plan is the Script, and its approval (the Draft stage's gate) is the confirmation.

## 4. Apply the cut

- **Editor of record: HyperFrames.** The cut is the project's footage track, never a baked file: one `<video>` clip per kept range on track 0, all on the same source (`media/take-cfr.mp4`), edge to edge, each with an `id` and `data-has-audio="true"`: `data-media-start` = the range's start in the source, `data-duration` = its length, `data-start` = the sum of the kept lengths before it (hyperframes-core's hard-cut recipe). media-use's `transcript-cut.mjs --plan` compiles the kept segments from the words and the removals: lay them as clips, never encode them. Studio shows the cut as it is written, and the person can trim any clip there.
- Put a 30 ms volume ramp in and out on every clip, in its `data-automation` volume lane (`{"t":0,"v":0},{"t":0.03,"v":1},{"t":<dur-0.03>,"v":1},{"t":<dur>,"v":0}`), otherwise every cut pops.
- Read the cut back with `npx hyperframes timeline --json`, then `lint` and `check`. The pass's preview is a draft render of the project (`npx hyperframes render --quality draft`).
- Every cut must work on audio AND picture (check the screen side too).
- Hand the user the cut to listen to before dressing it.

**One history turn per pass; the person's edits win.**
- Start each pass with `npx hyperframes history begin --who <your agent name> --label "<pass>"`, then `npx hyperframes history --since mine --who <your agent name>` to see what the person changed in Studio since your last turn. Build on their edits; never overwrite them. End the pass with `npx hyperframes history end`.
- A check failed, or the person says it got worse: `npx hyperframes history undo --who <your agent name>` takes back only your newest turn, never theirs.
- **Use my edit** (an answer on a pass's question): the person made that pass themselves in Studio. Read what they changed (`history --since mine`), keep it as the pass and change nothing of it, render the pass's preview from the project as it is, point the slot at it and ask again.

## 5. Dress in HyperFrames

Use HyperFrames `embedded-captions` (captions only) or `talking-head-recut` (captions, lower-thirds, graphics, b-roll). The cut is a media layer; captions and graphics are HTML on a paused GSAP timeline. Deterministic only: no wall-clock, no requestAnimationFrame loops, seeded randomness, no CSS transitions or keyframes for motion, entrances via `fromTo`, no infinite repeats, `power3`-style easing, no bounce by default.

**Caption timing.** Map words to the output timeline: `output_time = word.start - segment_start + segment_offset`. Cues are half-open integer frame windows `[startFrame, endFrame)`; adjacent cues may touch, never overlap, fade tails included. Captions are the top layer, added last, so no overlay hides them.

**Caption segmentation.** Decide in this order: keep a word, name, number+unit or fixed phrase whole; break at a clause, punctuation, breath or topic reset; keep the cue readable for its duration; then measure the rendered width.
- One rendered line per cue. Latin scripts: about 30-32 characters at most; CJK: about 10 characters.
- Target 0.8-2.5 s per cue, never under 0.5 s; grow a cue rather than flash one shorter than about 0.35 s.
- Never strand a lone article, particle or conjunction.
- The concatenated cues must reproduce the approved transcript exactly; terminology corrections are a lexicon applied once to all cues.
- Caption font = the brand font; small text contrast at least 4.5:1; no opaque bar; vertical default sits about 330 px above the bottom of a 1920 px frame.

**Motion graphics timed to speech.** A graphic adds what captions cannot (evidence, relationship, scale, structure, next action); plain narration stays caption-only.
- Bind each spoken element to its own keyword onset from the word timestamps: it enters on the first frame at or after that word, never on a fixed stagger or ahead of the speech. Neutral headings may enter at the beat start; connectors may follow a cue by a few frames.
- Hold the resolved state long enough to read, at least 1 s before exit. On A-roll, one-fact groups replace each other after 1.8-3.0 s; a dependent sequence may build in one scene and exit together.
- Background cards appear at their final size; content reveals inside them, the card never grows.
- Lower-thirds: name and role from the pod record, once per speaker. B-roll: reuse a `content-asset` first; for new b-roll see the `collage-broll` skill.

**Density and layout.**
- Never cover the face. Overlays go in the upper-middle area (around 280 px from the top of 1080x1920), horizontally centred, sized to clear both face and captions.
- Canvas clearance: 54 px horizontal, 88 px vertical; panel padding 48-72 px.
- One focal group plus 1-4 supporting elements; layouts hold 1.8-3.5 s before a major change; about 6-8 graphics per 2 minutes as a starting point, not a quota.
- Too empty: enrich the focal idea. Too crowded: drop support elements before shrinking text.

## 6. Background and colour from the booth look

Content Studio's booth records the RAW take and keeps the look the person picked before recording. Produce Content hands it to the run as the `look` param (`session.metadata.params.look`), a JSON string:

```json
{ "background": { "assetId": "…", "fileId": "…" } | { "mode": "blur" } | null,
  "colour": { "assetId": "…", "fileId": "…", "intensity": 1 } | null }
```

`assetId` is a Brand `brand-asset` (tag `booth-background`: a JPG or PNG; tag `colour-look`: a 33³ `.cube`); `fileId` is the file at its `asset-file-id`. Fetch a file with `GET /api/hub/files/<fileId>/url` (a signed URL: `{ url, expiresAt, mimeType }`), then download that URL.

With a look, the Background and Colour passes START from it. They stay passes: built after graphics, in that order, each with its own preview, its own slot (`layer-background`, `layer-colour`) and its own question: Approve, Rework, or Remove this pass. No look, or a `null` part of it: build that pass as you would without a look.

**The raw take is never overwritten.** A pass writes new files beside it, so removing a pass is always possible.

**Background pass.** The cut-out comes from the person's own matting tool (intent `edit_video`); the local matte is the fallback, never the first choice: it squashes each frame to 320×320 and has no memory between frames, so hair flickers and keeps the old room's colour.

1. **Prepare the take once.** Matte the WHOLE raw take, not the cut, so every kept range keeps its source times. A variable frame rate take is made constant first (`ffmpeg -i <raw-take> -vf fps=<fps> -c:v libx264 -crf 16 -c:a copy media/take-cfr.mp4`) and stored in the pod (`synap_store_file`) beside the raw take; a constant-rate take is used as it is. What the tool gets is that take's pod `file` entity id, never a URL you copied.
2. **Matte it with the person's `edit_video` tool.** `synap_list_capabilities({ intent: "edit_video" })` names the verb (Replicate RVM: `replicate_rvm_matte`). Run it with the take's file id in the verb's pod-file parameter and nothing else: RVM takes `{ "videoFile": <file entity id> }`. The pod signs the file when the run starts (a verb parameter declared `file:url`), so an approval that lands hours later still sends a live link; never fetch a signed URL yourself for it. A tool that declares no pod-file parameter takes `{ "video": <https URL> }`: get one with `GET /api/hub/files/<fileId>/url` just before the run (it lives one hour). A run that sends a pod file always comes back proposed (it sends the person's file out and bills their account): hand them the review link and wait for it. The result:
   - `status: "succeeded"`: `alphaUrl` (the matte, white = the person) and `foregroundUrl` (the model's own colour for the person, edges included);
   - `status: "processing"`: run its `next` (the read verb and parameters it names) every 30-60 s, for up to 15 min. Never run the matte verb again for the same take: it would bill again.
   Download every URL at once (`media/alpha.mp4`, `media/fgr.mp4`): providers delete them (Replicate after about an hour).
3. **Gate the matte** before anything uses it. It passes only if all hold:
   - frames: `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,width,height,duration -of json` on the take, the alpha and the foreground: same size, frame counts within 1, durations within one frame;
   - no flicker: `ffmpeg -i media/alpha.mp4 -vf "format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=media/alpha-diff.txt" -f null -`; the mean change between two frames stays under 4 (of 255) on at least 99% of frames;
   - the person never vanishes: `signalstats` YAVG of the alpha itself never drops under half its median;
   - look at the 3 frames with the largest change (hair, a hand, a held object) and say what you saw.
   These thresholds are a starting point, not measured yet: say when a take fails one by a hair. A failed gate goes to the fallback (step 7) and says which check failed.
4. **Defocus the background once.** An image look: one still, scaled to cover the frame and blurred, never per frame: `ffmpeg -i <background> -vf "scale=<W>:<H>:force_original_aspect_ratio=increase,crop=<W>:<H>,gblur=sigma=12" -frames:v 1 media/bg.png`. `mode: blur`: the real room, `ffmpeg -i <take> -vf gblur=sigma=30 -an media/room-blur.mp4`.
5. **Composite the person with ffmpeg**: the model's foreground colour, the matte choked one pixel and feathered, and a light wrap (the background's light bleeding over the person's edge). The person stays its own transparent layer, so HyperFrames can treat the background and the person apart:
   ```
   ffmpeg -i media/fgr.mp4 -i media/alpha.mp4 -loop 1 -framerate <fps> -i media/bg.png -filter_complex "
     [1:v]format=gray,erosion,gblur=sigma=1.2,split[m][mw];
     [mw]negate,gblur=sigma=8[out];[m]split[m1][m2];[m2][out]blend=all_mode=multiply,lut=c0=val*0.35[band];
     [2:v]gblur=sigma=20,format=yuva420p[glow];[glow][band]alphamerge[wrap];
     [0:v]format=yuva420p[fg];[fg][m1]alphamerge[p];[p][wrap]overlay=shortest=1[person]" \
     -map "[person]" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 24 -an media/person.webm
   ```
   For `mode: blur` the third input is `media/room-blur.mp4` without `-loop 1 -framerate <fps>`. The chain is a starting point, not yet tuned: check the edge on sample frames, and raise the choke or lower the wrap strength (`0.35`) when a halo shows.
6. **Lay it in HyperFrames.** Under the person, on the same ranges as the cut: the background (`media/bg.png`, `object-fit: cover`, for the whole video) or the blurred room (cut on the same ranges). The person video (`media/person.webm`) takes the raw take's place in the cut (same source in and out points; the sound still comes from the take); captions and graphics stay above it. Then:
   - grain on the background, so it matches the camera's noise: `npx hyperframes media-treatment --project . --file index.html --selector '<background>' --grading '{"details":{"grain":0.1}}' --apply --json`;
   - light match on the person: measure both with `ffmpeg -v error -i <file> -vf "signalstats,metadata=print:file=-" -f null -` (YAVG for brightness, UAVG/VAVG for the colour cast), then set the person's `adjust` section (exposure and warmth; `npx hyperframes media-treatment --capabilities --json` names the keys) until the person sits in the background's light. Small moves: the Colour pass grades both after this.
7. **Fallback, in order.** The video is never broken:
   - no `edit_video` tool, a refused or failed run, still processing after 15 min, or a failed gate: `npx hyperframes remove-background media/take-cfr.mp4 -o media/person.webm` (transparent VP9 WebM; the model, u2net_human_seg ~168 MB, downloads once to `~/.cache/hyperframes/`, and the first run loads it for 1-2 min with no output: it is not hung), laid over a blurred copy of the REAL room whatever the look asked (its rough edge carries the room's own colour, so it shows least there), with steps 6's grain and light match;
   - that failing too: the raw take stays in the cut, and the pass's preview and question say "background not applied" and why.
   Say in the pass's question which path made the preview.
8. Sample frames before the preview: a segmenter can drop an object the person holds or keep a large one beside them. Say what you saw.
9. Remove this pass: put the raw take back in the cut and drop the underlay; keep the matte files.

**Colour pass.**
1. Ingest the `.cube` (never read it into context): `npx hyperframes media-use resolve --type lut --from <downloaded>.cube --project .` validates it and freezes a copy as `.media/luts/lut_NNN.cube` (the `path` it prints).
2. Grade every footage element of the frame (the person, and the background image or the blurred room) with the grading block's `lut`, keys `src` and `intensity` (0 to 1, the look's intensity): `npx hyperframes media-treatment --project . --file index.html --selector '<element>' --grading '{"lut":{"src":".media/luts/lut_NNN.cube","intensity":<intensity>}}' --apply --json`. It writes `data-color-grading` on that element. An element the Background pass already treated (grain, light match) keeps those sections: send them again with `lut` in the same `--grading` object, so the LUT is added, not swapped in.
3. Remove this pass: `npx hyperframes media-treatment --project . --file index.html --selector '<element>' --clear` on each element it graded.

## 7. QA before showing anyone

1. `npx hyperframes lint` and `npx hyperframes check` clean.
2. Snapshot every graphic in its complete state (after its last reveal, before its exit) with `npx hyperframes snapshot` and open the images: whole phrases, no orphan words, no overflow, centred, clear of captions and face.
3. Snapshot both sides of every cut (cut -0.1 s and +0.2 s): no visual jump, a persistent element sits at the same position on both sides.
4. Measure the audio: `ffmpeg -i out.mp4 -af ebur128=peak=true -f null -`; target about -14 LUFS integrated, true peak at or below -1 dBTP; look for spikes at seams.
5. `ffprobe` the output: duration matches the plan, audio and video present, stream starts within max(0.1 s, 2/fps).
6. Confirm the brand font actually loaded (fallbacks fail silently).
Cap self-fix at 3 passes, then report what remains.

## 8. Review, render, save

1. One human review of a preview. Then render with `npx hyperframes render`.
2. Upload the final MP4 to the pod (`synap_store_file`) and record it: the composition as `content-composition`, the render as `render-job` / `content-asset`, linked to the content piece. Save reusable pieces (lower-third, caption style) as assets.

## Revisions

Start from the delivered version. Change only what was flagged; keep every settled decision (wording, splits, placement, size, fps). A late cut is one frame-aligned range applied to video, audio, captions and graphics together. Fix a repeated defect across every graphic that shares it, then re-snapshot only those.

## Sources

Adapted from video-use SKILL.md (MIT, © browser-use) and cut-motion docs (Apache-2.0, cut-motion by Endless1936, © 2026 prototech).
