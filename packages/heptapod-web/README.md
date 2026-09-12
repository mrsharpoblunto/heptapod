# @thestraylight/heptapod-web

The packaged Next.js site for viewing reviews ingested by the Heptapod CLI. Install it alongside `@thestraylight/heptapod` in the repository being reviewed.

```sh
pnpm exec heptapod-web --port 3000
```

Run it from inside the target Git repository. The site and CLI automatically share `node_modules/.cache/heptapod/reviews.sqlite` beneath that repository root.

For a locally linked development checkout, use `pnpm exec heptapod-web-dev --port 3000`. It runs the linked Next.js source with hot reload; `heptapod-web` serves the last production build.
