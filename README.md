# Newsfly

A *Drosophila* connectome reading the news wire.

Leaky integrate-and-fire simulation over the real FlyWire FAFB v783 connectome —
139,255 neurons — driven by live headlines. Stories enter through the sensory
populations; the descending neurons decode to an editorial verdict. Every
decision is logged with its firing rates and a link to the source.

Built for Klaxon Wire.

## What is and isn't real

- **Real:** the connectome. Every neuron position, neurotransmitter, cell class
  and synaptic connection comes from FlyWire FAFB v783. Nothing is invented.
- **Real:** the simulation. Conductance-free leaky integrate-and-fire, one
  simulated millisecond per step, acetylcholine excitatory, GABA and glutamate
  inhibitory, synaptic weight scaled by synapse count.
- **A choice, not biology:** which output means what. The left descending
  neurons are read as WIRE, the right as SKIP. The fly has no opinion about
  hemispheres; the mapping is arbitrary and fixed.
- **A choice, not biology:** the five stimulus channels. Footage, casualties,
  hardware, US relevance and recency are Klaxon Wire's desk criteria, scored by
  keyword, then injected as sensory drive.

## Data

FlyWire FAFB v783, CC-BY 4.0. Cite FlyWire if you publish anything from this.
<https://flywire.ai> · <https://codex.flywire.ai>

Committed to the repo:

| file | size | what |
| --- | --- | --- |
| `data/neurons.bin` | 1.9 MB | position, neurotransmitter, class, side, flow |
| `data/ids.txt.gz` | 468 KB | FlyWire root_id per index |

Fetched on first boot and cached as `data/edges.bin`: the Connections (Filtered)
table, ~68 MB, pulled from the Codex API using `CODEX_TOKEN`.

## Deploy

1. Push this repo to GitHub (public).
2. On Render: **New → Web Service**, pick the repo.
   - Runtime **Node**
   - Build command `npm install`
   - Start command `npm start`
3. Add an environment variable `CODEX_TOKEN` with your Codex API token.
   It is only needed on the first boot; after that `data/edges.bin` is cached.
4. Deploy. The first boot downloads and packs the connection table, which takes
   a few minutes. Watch the log for `[edges] packed N synaptic connections`.

No dependencies. Node 18 or newer.

## Endpoints

| path | what |
| --- | --- |
| `/` | the page |
| `/stream` | Server-Sent Events: telemetry and population activity |
| `/api/ledger` | last 100 decisions |
| `/api/meta` | neuron and edge counts, population sizes |

## Tuning

In `server.js`:

- `W_SCALE` — synapse count to membrane units. Raise it if the brain is silent,
  lower it if everything saturates.
- `READ_MS` — simulated milliseconds spent per headline.
- `FEEDS` — the wire. Add regional and non-English sources here.
- the sim clock at the bottom — 400 steps per 100 ms of wall time. Drop it if
  the host's CPU can't keep up.
