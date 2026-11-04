# A small JSON Schema validator for the deploy shell tests (they run with jq
# and no node_modules). It knows the keywords deploy/schemas/*.json use and
# FAILS on any other one, so a schema edit can never be checked vacuously.
#   jq -rn --slurpfile s <schema> --slurpfile d <doc> -f json-schema-lite.jq
# prints one line per violation ("$.path: why"), nothing when the doc is valid.
def known: ["$schema", "$id", "title", "description", "type", "const", "enum", "required",
            "properties", "additionalProperties", "items", "minimum", "maximum",
            "minItems", "maxItems", "pattern"];
def jtype: if type == "number" then (if . == floor then "integer" else "number" end) else type end;
def errs($s; $p):
  . as $v | ($v | jtype) as $j
  | [ $s | keys[] | select(. as $k | known | index($k) | not) | "\($p): schema keyword \(.) is not supported by json-schema-lite.jq" ]
  + (if $s | has("type") then
       (if [$s.type] | flatten | any(. == $j or (. == "number" and $j == "integer")) then [] else ["\($p): is \($j), expected \($s.type | tojson)"] end)
     else [] end)
  + (if ($s | has("const")) and $v != $s.const then ["\($p): \($v | tojson) is not \($s.const | tojson)"] else [] end)
  + (if ($s | has("enum")) and (any($s.enum[]; . == $v) | not) then ["\($p): \($v | tojson) is not one of \($s.enum | tojson)"] else [] end)
  + (if ($s | has("minimum")) and ($j == "number" or $j == "integer") and $v < $s.minimum then ["\($p): \($v) < \($s.minimum)"] else [] end)
  + (if ($s | has("maximum")) and ($j == "number" or $j == "integer") and $v > $s.maximum then ["\($p): \($v) > \($s.maximum)"] else [] end)
  + (if ($s | has("pattern")) and $j == "string" and ($v | test($s.pattern) | not) then ["\($p): \($v | tojson) does not match \($s.pattern)"] else [] end)
  + (if $j == "object" then
       [ ($s.required // [])[] | select(. as $k | $v | has($k) | not) | "\($p): missing \(.)" ]
       + [ $v | keys[] | . as $k
           | if ($s.properties // {}) | has($k) then ($v[$k] | errs($s.properties[$k]; "\($p).\($k)"))[]
             elif $s.additionalProperties == false then "\($p): unexpected property \($k)"
             else empty end ]
     else [] end)
  + (if $j == "array" then
       (if ($s | has("minItems")) and ($v | length) < $s.minItems then ["\($p): fewer than \($s.minItems) items"] else [] end)
       + (if ($s | has("maxItems")) and ($v | length) > $s.maxItems then ["\($p): more than \($s.maxItems) items"] else [] end)
       + (if $s | has("items") then [ range(0; $v | length) as $i | ($v[$i] | errs($s.items; "\($p)[\($i)]"))[] ] else [] end)
     else [] end);
$d[0] | errs($s[0]; "$") | .[]
