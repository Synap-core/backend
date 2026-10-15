/**
 * Response bodies for the built-in reader tests. NO live network in tests.
 *
 * Provenance: these are hand-built from each endpoint's documented response
 * shape (oEmbed spec + provider docs, FixTweet "Status Fetch API" wiki, AT
 * Protocol lexicons `app.bsky.feed.getPostThread` / `resolveHandle`, HN Algolia
 * `/api/v1/items/:id`, GitHub REST `GET /repos/{o}/{r}` + `/readme`, Wikimedia
 * REST `page/summary` + TextExtracts, arXiv Atom export API, Reddit thread
 * `.rss`). They could not be recorded live from this container: its egress
 * policy refuses these hosts. Field names are the documented ones; values are
 * illustrative.
 */

import type { WebFetcher } from "../fetch.js";

export function respond(
  body: string,
  init: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
  } = {}
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": init.contentType ?? "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

export const json = (v: unknown, status = 200) =>
  respond(JSON.stringify(v), { status });

type Route = [match: string | RegExp, answer: () => Response];

/**
 * A fake `safePublicFetch`: the first route whose prefix (string) or regex
 * matches the requested URL answers. Anything else throws — an unexpected
 * request is a test failure, not a silent pass.
 */
export function fakeWeb(routes: Route[]): WebFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    for (const [m, answer] of routes) {
      if (typeof m === "string" ? url.startsWith(m) : m.test(url))
        return answer();
    }
    throw new Error(`unexpected request in test: ${url}`);
  }) as unknown as WebFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

// ── oEmbed ──

export const YOUTUBE_OEMBED = {
  title: "Never Gonna Give You Up",
  author_name: "Rick Astley",
  author_url: "https://www.youtube.com/@RickAstleyYT",
  type: "video",
  height: 113,
  width: 200,
  version: "1.0",
  provider_name: "YouTube",
  provider_url: "https://www.youtube.com/",
  thumbnail_height: 360,
  thumbnail_width: 480,
  thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  html: '<iframe width="200" height="113" src="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed"></iframe>',
};

export const TIKTOK_OEMBED = {
  version: "1.0",
  type: "video",
  title: "Scramble up ur name & I'll try to guess it #foryoupage",
  author_url: "https://www.tiktok.com/@scout2015",
  author_name: "Scout, Suki & Stella",
  width: "100%",
  height: "100%",
  html: '<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@scout2015/video/6718335390845095173"></blockquote>',
  thumbnail_width: 720,
  thumbnail_height: 1280,
  thumbnail_url: "https://p16-sign.tiktokcdn-us.com/obj/cover.jpeg",
  provider_url: "https://www.tiktok.com",
  provider_name: "TikTok",
};

export const VIMEO_OEMBED = {
  type: "video",
  version: "1.0",
  provider_name: "Vimeo",
  provider_url: "https://vimeo.com/",
  title: "The New Vimeo Player (You Know, For Videos)",
  author_name: "Vimeo",
  author_url: "https://vimeo.com/staff",
  is_plus: "0",
  account_type: "live_business",
  html: '<iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e"></iframe>',
  width: 640,
  height: 360,
  duration: 62,
  description:
    "It may look (mostly) the same on the surface, but under the hood we totally rebuilt our player.",
  thumbnail_url: "https://i.vimeocdn.com/video/452001751-640",
  thumbnail_width: 640,
  thumbnail_height: 360,
  upload_date: "2013-10-15 14:08:29",
  video_id: 76979871,
  uri: "/videos/76979871",
};

// ── X ──

export const X_OEMBED = {
  url: "https://twitter.com/jack/status/20",
  author_name: "jack",
  author_url: "https://twitter.com/jack",
  html: '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote>\n',
  width: 550,
  height: null,
  type: "rich",
  cache_age: "3153600000",
  provider_name: "Twitter",
  provider_url: "https://twitter.com",
  version: "1.0",
};

export const FX_STATUS = {
  code: 200,
  message: "OK",
  tweet: {
    url: "https://x.com/jack/status/20",
    id: "20",
    text: "just setting up my twttr",
    author: {
      name: "jack",
      screen_name: "jack",
      avatar_url: "https://pbs.twimg.com/profile_images/1/a.jpg",
      url: "https://x.com/jack",
    },
    replies: 16000,
    retweets: 120000,
    likes: 300000,
    views: null,
    created_at: "Tue Mar 21 20:50:14 +0000 2006",
    created_timestamp: 1142974214,
    media: {
      all: [
        {
          type: "photo",
          url: "https://pbs.twimg.com/media/A.jpg?name=orig",
          width: 1200,
          height: 800,
        },
        {
          type: "video",
          url: "https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/b.mp4",
          thumbnail_url:
            "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/b.jpg",
          width: 720,
          height: 1280,
          duration: 12.5,
          format: "video/mp4",
        },
      ],
    },
  },
};

// ── Bluesky ──

export const BSKY_RESOLVE = { did: "did:plc:z72i7hdynmk6r22z27h6tvur" };

export const BSKY_THREAD = {
  thread: {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      uri: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l",
      cid: "bafyrei",
      author: {
        did: "did:plc:z72i7hdynmk6r22z27h6tvur",
        handle: "bsky.app",
        displayName: "Bluesky",
        labels: [],
      },
      record: {
        $type: "app.bsky.feed.post",
        createdAt: "2024-10-16T18:02:39.000Z",
        text: "Video is here! Upload videos up to 60 seconds.",
      },
      embed: {
        $type: "app.bsky.embed.images#view",
        images: [
          {
            thumb: "https://cdn.bsky.app/img/feed_thumbnail/plain/did/a@jpeg",
            fullsize: "https://cdn.bsky.app/img/feed_fullsize/plain/did/a@jpeg",
            alt: "",
            aspectRatio: { width: 1000, height: 750 },
          },
        ],
      },
      replyCount: 10,
      repostCount: 20,
      likeCount: 30,
      quoteCount: 4,
      indexedAt: "2024-10-16T18:02:39.000Z",
      labels: [],
    },
  },
};

// ── Hacker News (Algolia) ──

export const HN_ITEM = {
  id: 8863,
  created_at: "2007-04-04T19:16:40.000Z",
  created_at_i: 1175714200,
  type: "story",
  author: "dhouston",
  title: "My YC app: Dropbox - Throw away your USB drive",
  url: "http://www.getdropbox.com/u/2/screencast.html",
  text: null,
  points: 111,
  parent_id: null,
  story_id: 8863,
  children: [
    {
      id: 9224,
      created_at: "2007-04-05T15:16:54.000Z",
      type: "comment",
      author: "BrandonM",
      text: "<p>I have a few qualms with this app:</p><p>1. For a Linux user, you can already build such a system yourself quite trivially.</p>",
      children: [
        {
          id: 9272,
          type: "comment",
          author: "dhouston",
          text: "thanks for the feedback!",
          children: [],
        },
      ],
    },
    {
      id: 8952,
      type: "comment",
      author: "nickb",
      text: "Very cool.",
      children: [],
    },
  ],
};

// ── GitHub ──

export const GH_REPO = {
  id: 1,
  name: "defuddle",
  full_name: "kepano/defuddle",
  owner: { login: "kepano", html_url: "https://github.com/kepano" },
  html_url: "https://github.com/kepano/defuddle",
  description: "Extract the main content from web pages.",
  created_at: "2024-08-01T00:00:00Z",
  pushed_at: "2026-10-10T15:35:10Z",
  homepage: "https://defuddle.md",
  stargazers_count: 4200,
  forks_count: 150,
  open_issues_count: 20,
  language: "TypeScript",
  license: { key: "mit", spdx_id: "MIT" },
  topics: ["readability", "html"],
  archived: false,
};

export const GH_README =
  "# Defuddle\n\nDefuddle extracts the main content from web pages, removing clutter like comments, sidebars, headers, footers.";

// ── Wikipedia ──

export const WIKI_SUMMARY = {
  type: "standard",
  title: "Ada Lovelace",
  displaytitle: "Ada Lovelace",
  description: "English mathematician (1815–1852)",
  extract:
    "Augusta Ada King, Countess of Lovelace was an English mathematician and writer.",
  thumbnail: {
    source: "https://upload.wikimedia.org/thumb/ada-330px.jpg",
    width: 330,
    height: 440,
  },
  originalimage: {
    source: "https://upload.wikimedia.org/ada.jpg",
    width: 1200,
    height: 1600,
  },
  content_urls: {
    desktop: { page: "https://en.wikipedia.org/wiki/Ada_Lovelace" },
  },
  lang: "en",
};

export const WIKI_EXTRACT = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 974,
        ns: 0,
        title: "Ada Lovelace",
        extract:
          "Augusta Ada King, Countess of Lovelace was an English mathematician and writer, chiefly known for her work on Charles Babbage's proposed mechanical general-purpose computer, the Analytical Engine.\n\nEarly life\nLovelace was born 10 December 1815.",
      },
    ],
  },
};

// ── arXiv ──

export const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?id_list=1706.03762" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: id_list=1706.03762</title>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You
  Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose a new simple network architecture, the
Transformer, based solely on attention mechanisms.
</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

export const ARXIV_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: id_list=9999.99999</title>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
</feed>`;

// ── Reddit (.rss) ──

export const REDDIT_RSS = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><category term="programming" label="r/programming"/><updated>2026-10-01T10:00:00+00:00</updated><title>Why we moved off microservices : programming</title>
<entry><author><name>/u/alice</name><uri>https://www.reddit.com/user/alice</uri></author><category term="programming" label="r/programming"/><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;We merged 40 services into one deployable and cut our pager load in half.&lt;/p&gt; &lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/alice&quot;&gt; /u/alice &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://example.com/blog/monolith&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/programming/comments/abc123/why/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><id>t3_abc123</id><media:thumbnail url="https://external-preview.redd.it/thumb.jpg?auto=webp&amp;s=1"/><link href="https://www.reddit.com/r/programming/comments/abc123/why/"/><updated>2026-10-01T09:00:00+00:00</updated><published>2026-10-01T09:00:00+00:00</published><title>Why we moved off microservices</title></entry>
<entry><author><name>/u/bob</name><uri>https://www.reddit.com/user/bob</uri></author><category term="programming" label="r/programming"/><content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Same experience here.&lt;/p&gt; &lt;/div&gt;</content><id>t1_def456</id><link href="https://www.reddit.com/r/programming/comments/abc123/why/def456/"/><updated>2026-10-01T09:30:00+00:00</updated><title>/u/bob on Why we moved off microservices</title></entry>
</feed>`;

// ── a page ──

const LONG_BODY = Array.from(
  { length: 12 },
  (_, i) =>
    `<p>Paragraph ${i + 1} of the real article body explains the migration in detail, with numbers and the reasons behind each decision we made.</p>`
).join("\n");

/** og:description deliberately DIFFERS from the body: the body must win. */
export const ARTICLE_HTML = `<!doctype html><html lang="en"><head>
<title>Migrating to a monolith | Example Blog</title>
<meta property="og:title" content="Migrating to a monolith">
<meta property="og:description" content="TEASER-ONLY: a short marketing blurb that is not the article.">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="Example Blog">
<link rel="canonical" href="https://example.com/blog/monolith">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"Migrating to a monolith","author":{"@type":"Person","name":"Ada Byron"},"datePublished":"2026-09-30T08:00:00Z"}</script>
</head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<main><article><h1>Migrating to a monolith</h1>
${LONG_BODY}
</article></main>
<footer>© Example Blog — subscribe to our newsletter</footer>
</body></html>`;

/** A client-rendered app shell: metadata, no prose. */
export const JS_SHELL_HTML = `<!doctype html><html><head>
<title>Dashboard App</title>
<meta property="og:title" content="Dashboard App">
<meta property="og:image" content="https://cdn.example.com/og.png">
</head><body><noscript>You need to enable JavaScript to run this app.</noscript>
<div id="root"></div><script src="/static/js/main.4f2a.js"></script></body></html>`;

/** Cloudflare's managed-challenge interstitial (served with 403/503 or 200). */
export const CLOUDFLARE_CHALLENGE_HTML = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body><div class="main-wrapper" role="main">
<div class="main-content"><h1 class="zone-name-title h1">example.com</h1>
<h2 class="h2" id="challenge-running">Checking if the site connection is secure</h2>
<noscript><div class="h2">Enable JavaScript and cookies to continue</div></noscript></div></div>
<script>(function(){window._cf_chl_opt={cvId: '3',cZone: "example.com",cType: 'managed'};var a = document.createElement('script');a.src = '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1';document.getElementsByTagName('head')[0].appendChild(a);}());</script>
</body></html>`;

/** DataDome's captcha page. */
export const DATADOME_HTML = `<html><head><title>example.com</title></head><body style="margin:0">
<p id="cmsg">Please enable JS and disable any ad blocker</p>
<script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqA','hsh':'2211F5','t':'fe','host':'geo.captcha-delivery.com'}</script>
<script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;

/** An article that discusses Cloudflare challenges — it is NOT one. */
export const ARTICLE_ABOUT_CHALLENGES_HTML = ARTICLE_HTML.replace(
  "<h1>Migrating to a monolith</h1>",
  "<h1>Migrating to a monolith</h1><p>Our users kept seeing a page titled Just a moment... while Cloudflare was checking your browser; we turned that challenge off.</p>"
);

/** A sign-in wall. */
export const LOGIN_WALL_HTML = `<!doctype html><html><head><title>Sign in</title>
<link rel="canonical" href="https://social.example.com/login"></head><body>
<form action="/session" method="post"><input type="email" name="email"><input type="password" name="password">
<button>Sign in</button></form><p>Sign in to see this post.</p></body></html>`;
