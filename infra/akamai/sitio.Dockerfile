# La página de estilo-internacional se hizo para el hosting de ChatGPT Sites (Cloudflare). Aquí se compila
# como sitio estático con Next.js normal (solo usa next y react) y se sirve con Caddy.
FROM node:22-slim AS compilar
WORKDIR /sitio
COPY app ./app
COPY public ./public
ARG SITIO_URL=""
RUN rm -f app/chatgpt-auth.ts \
 && if [ -n "$SITIO_URL" ]; then sed -i "s#https://estilo-internacional.berrygenet64.chatgpt.site#$SITIO_URL#" app/layout.tsx; fi
COPY <<'JSON' package.json
{ "name": "estilo-internacional-sitio", "private": true, "type": "module",
  "dependencies": { "next": "16.3.4", "react": "19.2.6", "react-dom": "19.2.6" },
  "devDependencies": { "typescript": "5.9.3", "@types/react": "19.2.14", "@types/node": "22.19.19" } }
JSON
COPY <<'JS' next.config.mjs
export default { output: "export", images: { unoptimized: true } };
JS
COPY <<'JSON' tsconfig.json
{ "compilerOptions": { "target": "ES2017", "lib": ["dom", "dom.iterable", "esnext"], "skipLibCheck": true, "strict": true,
    "noEmit": true, "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true,
    "isolatedModules": true, "jsx": "react-jsx", "plugins": [{ "name": "next" }] },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"], "exclude": ["node_modules"] }
JSON
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --no-audit --no-fund && npx next build

FROM caddy:2.10
COPY --from=compilar /sitio/out /srv/sitio
