-- 0398 — intent contracts and the reachability intents (Stage 1 plan U1,
-- document 64072312; addendum 000e75ff §2–§4; founder, 2026-11-04: "Yes, all
-- defaults" on F1–F6)
--
-- What a capability DOES is a row, not a TypeScript union (0283). Until now an
-- intent described a ONE-SHOT verb: one input (`input_schema`, 0368), no output
-- and no lifecycle. A reachable URL is not one-shot: it is created, checked,
-- maybe renewed, and revoked, and it returns a URL and a handle to tear it
-- down. So an intent may now carry a CONTRACT:
--
--   capability_intents.contract  {version, output, ops, constraints}
--     output       the JSON Schema every op returns
--     ops.<op>     create | status | renew | revoke: {required, requiredWhen?,
--                  input?}. `create`'s input is the row's `input_schema`, so the
--                  app intent doors (intent-actions.ts) read it unchanged and
--                  the shape lives in ONE column. `requiredWhen: "expiresAt"`
--                  = owed once an output carries expiresAt.
--     constraints  the keys a need may set and a provider's `offers` declare
--   NULL = a one-shot intent with no lifecycle (every row before this file).
--
--   skills.intent_op  which op of its intent's contract a verb implements.
--                     NULL = the intent's single default op, so every existing
--                     verb keeps working unchanged. No CHECK: the op set is the
--                     contract's, validated by the applier (plan U3).
--
-- `skills.execution_mode` gains the value `hosted` (a verb that runs on an
-- installation and is pulled by its computer). It is a text column with no
-- CHECK, so no DDL here: the Drizzle enum list carries it.
--
-- FIVE ROWS, post-seed (REGISTERED_EXTRAS), each with its one input and its
-- contract. Vendor names appear nowhere: a provider is any capability whose
-- verbs declare the intent. Effects follow 0283: `act` reaches outside the pod
-- (an app's run of it is always proposed, `appRunMustPropose`), `write` files
-- into the pod.
--   expose_http   act    make an HTTP service reachable at a URL
--   tunnel        act    carry traffic from an edge to a computer, outbound only
--   dns_record    act    one DNS record in a zone the person controls
--   tls_cert      act    obtain and renew a certificate
--   render_video  write  render a composition (a pod file) to MP4 or stills
--
-- Fresh installs get both columns from 0000_baseline_schema.sql; this file is
-- for pods that already booted, and inserts the rows on both. Like 0370, a
-- shape (input or contract) is set only where none is set, so an edited one is
-- never overwritten, and a second run changes nothing.

ALTER TABLE "capability_intents" ADD COLUMN IF NOT EXISTS "contract" jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "intent_op" text;

INSERT INTO "capability_intents" ("slug", "effect", "statement", "synonyms")
VALUES
  ('expose_http', 'act', 'Make an HTTP service reachable at a URL, under an access mode the person chooses.',
   ARRAY['make reachable', 'expose a service', 'url for a local app', 'reverse proxy', 'share a web app', 'route a subdomain']),
  ('tunnel', 'act', 'Carry traffic from an edge to a service on a computer, over an outbound-only connection.',
   ARRAY['outbound tunnel', 'reverse tunnel', 'connect a computer to the edge', 'reach a service without opening a port']),
  ('dns_record', 'act', 'Create, update or remove one DNS record in a zone the person controls.',
   ARRAY['dns record', 'add a cname', 'point a domain', 'dns entry', 'subdomain record']),
  ('tls_cert', 'act', 'Obtain and renew a TLS certificate for a hostname.',
   ARRAY['tls certificate', 'ssl certificate', 'https certificate', 'issue a certificate', 'renew a certificate'])
ON CONFLICT ("slug") DO NOTHING;

-- expose_http
UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "installationId": {
      "type": "string",
      "format": "uuid",
      "description": "The installation this is for. With needKey, the idempotency key: a retry returns the same handle."
    },
    "needKey": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{0,63}$",
      "description": "Which need of that installation."
    },
    "computer": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "The computer the service runs on (its id), or \"pod\"."
    },
    "source": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {"const":"local_port"},
            "port": {"type":"integer","minimum":1,"maximum":65535},
            "protocol": {"enum":["http","ws"]}
          },
          "required": ["kind","port"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {"const":"unix_socket"},
            "path": {"type":"string","pattern":"^/","maxLength":512}
          },
          "required": ["kind","path"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {"const":"static_bundle"},
            "fileId": {
              "type": "string",
              "format": "uuid",
              "description": "The pod file holding the bundle."
            }
          },
          "required": ["kind","fileId"],
          "additionalProperties": false
        }
      ],
      "description": "What to expose."
    },
    "hostname": {
      "oneOf": [
        {"const":"any"},
        {
          "type": "object",
          "properties": {
            "subdomain": {"type":"string","pattern":"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"}
          },
          "required": ["subdomain"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "fqdn": {
              "type": "string",
              "pattern": "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
            }
          },
          "required": ["fqdn"],
          "additionalProperties": false
        }
      ],
      "description": "The name the person wants; \"any\" lets the provider pick."
    },
    "auth": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{0,63}$",
      "description": "Who may open it: public, pod, tailnet, provider. Open: a provider declares what it enforces."
    },
    "healthPath": {"type":"string","pattern":"^/","maxLength":512}
  },
  "required": ["installationId","needKey","computer","source","hostname","auth"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'expose_http' AND "input_schema" IS NULL;

UPDATE "capability_intents"
SET "contract" = '{
  "version": 1,
  "output": {
    "type": "object",
    "properties": {
      "url": {
        "type": ["string","null"],
        "format": "uri",
        "maxLength": 2048,
        "description": "The reachable address; null until live."
      },
      "state": {"enum":["pending","live","degraded","revoked","failed"]},
      "handle": {
        "description": "The provider reference (an id, a record, a list for a composite). The pod stores it and never reads it."
      },
      "authApplied": {
        "type": ["string","null"],
        "pattern": "^[a-z][a-z0-9_]{0,63}$",
        "description": "The access mode the provider actually enforces."
      },
      "public": {
        "type": "boolean",
        "description": "True only when anyone on the internet can reach it."
      },
      "expiresAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "When it must be renewed; null when it never expires."
      },
      "checkedAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "The last health check."
      },
      "detail": {
        "type": ["string","null"],
        "maxLength": 1000,
        "description": "The last result in plain words."
      }
    },
    "required": ["url","state","handle","authApplied","public"],
    "additionalProperties": false
  },
  "ops": {
    "create": {"required":true},
    "status": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    },
    "renew": {
      "required": false,
      "requiredWhen": "expiresAt",
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    }
  },
  "constraints": ["auth","source","hostname","runsOn","public","port"]
}'::jsonb
WHERE "slug" = 'expose_http' AND "contract" IS NULL;

-- tunnel
UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "installationId": {
      "type": "string",
      "format": "uuid",
      "description": "The installation this is for. With needKey, the idempotency key: a retry returns the same handle."
    },
    "needKey": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{0,63}$",
      "description": "Which need of that installation."
    },
    "computer": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "The computer the service runs on (its id), or \"pod\"."
    },
    "upstream": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {"const":"local_port"},
            "port": {"type":"integer","minimum":1,"maximum":65535},
            "protocol": {"enum":["http","ws"]}
          },
          "required": ["kind","port"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {"const":"unix_socket"},
            "path": {"type":"string","pattern":"^/","maxLength":512}
          },
          "required": ["kind","path"],
          "additionalProperties": false
        }
      ],
      "description": "The service on the computer the tunnel carries traffic to."
    }
  },
  "required": ["installationId","needKey","computer","upstream"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'tunnel' AND "input_schema" IS NULL;

UPDATE "capability_intents"
SET "contract" = '{
  "version": 1,
  "output": {
    "type": "object",
    "properties": {
      "hostname": {
        "type": ["string","null"],
        "maxLength": 253,
        "description": "The edge name traffic enters by (a DNS target); null until live."
      },
      "state": {"enum":["pending","live","degraded","revoked","failed"]},
      "handle": {
        "description": "The provider reference (an id, a record, a list for a composite). The pod stores it and never reads it."
      },
      "expiresAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "When it must be renewed; null when it never expires."
      },
      "checkedAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "The last health check."
      },
      "detail": {
        "type": ["string","null"],
        "maxLength": 1000,
        "description": "The last result in plain words."
      }
    },
    "required": ["hostname","state","handle"],
    "additionalProperties": false
  },
  "ops": {
    "create": {"required":true},
    "status": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    },
    "renew": {
      "required": false,
      "requiredWhen": "expiresAt",
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    },
    "revoke": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    }
  },
  "constraints": ["runsOn","source"]
}'::jsonb
WHERE "slug" = 'tunnel' AND "contract" IS NULL;

-- dns_record
UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "installationId": {
      "type": "string",
      "format": "uuid",
      "description": "The installation this is for. With needKey, the idempotency key: a retry returns the same handle."
    },
    "needKey": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{0,63}$",
      "description": "Which need of that installation."
    },
    "zone": {
      "type": "string",
      "pattern": "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
      "description": "A zone the person controls."
    },
    "name": {
      "type": "string",
      "pattern": "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
      "description": "The full record name, inside the zone."
    },
    "type": {"enum":["A","AAAA","CNAME","TXT"]},
    "target": {"type":"string","minLength":1,"maxLength":2048},
    "ttl": {"type":"integer","minimum":60,"maximum":86400}
  },
  "required": ["installationId","needKey","zone","name","type","target"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'dns_record' AND "input_schema" IS NULL;

UPDATE "capability_intents"
SET "contract" = '{
  "version": 1,
  "output": {
    "type": "object",
    "properties": {
      "fqdn": {"type":["string","null"],"maxLength":253},
      "state": {"enum":["pending","live","degraded","revoked","failed"]},
      "handle": {
        "description": "The provider reference (an id, a record, a list for a composite). The pod stores it and never reads it."
      },
      "checkedAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "The last check."
      },
      "detail": {
        "type": ["string","null"],
        "maxLength": 1000,
        "description": "The last result in plain words."
      }
    },
    "required": ["fqdn","state","handle"],
    "additionalProperties": false
  },
  "ops": {
    "create": {"required":true},
    "status": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    },
    "revoke": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    }
  },
  "constraints": ["zone","type"]
}'::jsonb
WHERE "slug" = 'dns_record' AND "contract" IS NULL;

-- tls_cert
UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "installationId": {
      "type": "string",
      "format": "uuid",
      "description": "The installation this is for. With needKey, the idempotency key: a retry returns the same handle."
    },
    "needKey": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{0,63}$",
      "description": "Which need of that installation."
    },
    "hostname": {
      "type": "string",
      "pattern": "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
    },
    "challenge": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]{0,63}$",
      "description": "How ownership is proven (for example http_01, dns_01). Open: a provider declares what it supports."
    }
  },
  "required": ["installationId","needKey","hostname"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'tls_cert' AND "input_schema" IS NULL;

UPDATE "capability_intents"
SET "contract" = '{
  "version": 1,
  "output": {
    "type": "object",
    "properties": {
      "hostname": {"type":"string","maxLength":253},
      "state": {"enum":["pending","live","degraded","revoked","failed"]},
      "handle": {
        "description": "The provider reference (an id, a record, a list for a composite). The pod stores it and never reads it."
      },
      "expiresAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "When the certificate expires."
      },
      "checkedAt": {
        "type": ["string","null"],
        "format": "date-time",
        "description": "The last check."
      },
      "detail": {
        "type": ["string","null"],
        "maxLength": 1000,
        "description": "The last result in plain words."
      }
    },
    "required": ["hostname","state","handle","expiresAt"],
    "additionalProperties": false
  },
  "ops": {
    "create": {"required":true},
    "status": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    },
    "renew": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    },
    "revoke": {
      "required": true,
      "input": {
        "type": "object",
        "properties": {
          "installationId": {"type":"string","format":"uuid"},
          "needKey": {"type":"string","pattern":"^[a-z][a-z0-9_]{0,63}$"},
          "handle": {"description":"What create returned."}
        },
        "required": ["installationId","needKey","handle"],
        "additionalProperties": false
      }
    }
  },
  "constraints": ["hostname","challenge"]
}'::jsonb
WHERE "slug" = 'tls_cert' AND "contract" IS NULL;

-- render_video
UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "compositionFileId": {
      "type": "string",
      "format": "uuid",
      "description": "The pod file holding the composition."
    },
    "format": {"enum":["mp4","png_sequence"]},
    "width": {"type":"integer","minimum":16,"maximum":7680},
    "height": {"type":"integer","minimum":16,"maximum":4320},
    "fps": {"type":"integer","minimum":1,"maximum":120}
  },
  "required": ["compositionFileId","format"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'render_video' AND "input_schema" IS NULL;

UPDATE "capability_intents"
SET "contract" = '{
  "version": 1,
  "output": {
    "type": "object",
    "properties": {
      "state": {"enum":["pending","running","done","failed"]},
      "handle": {
        "description": "The provider reference (an id, a record, a list for a composite). The pod stores it and never reads it."
      },
      "fileIds": {
        "type": "array",
        "items": {"type":"string","format":"uuid"},
        "maxItems": 1000,
        "description": "The pod files the render produced."
      },
      "detail": {
        "type": ["string","null"],
        "maxLength": 1000,
        "description": "The last result in plain words."
      }
    },
    "required": ["state","handle","fileIds"],
    "additionalProperties": false
  },
  "ops": {
    "create": {"required":true},
    "status": {
      "required": false,
      "input": {
        "type": "object",
        "properties": {"handle":{"description":"What create returned (the run)."}},
        "required": ["handle"],
        "additionalProperties": false
      }
    }
  },
  "constraints": ["format"]
}'::jsonb
WHERE "slug" = 'render_video' AND "contract" IS NULL;

