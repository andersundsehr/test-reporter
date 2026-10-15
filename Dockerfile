FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY src ./src
COPY vite.config.ts tsconfig.json ./
RUN yarn build

FROM node:22-alpine

WORKDIR /app
COPY --from=build /app/dist/test-reporter.cjs ./test-reporter.cjs
COPY bin/test-reporter /usr/local/bin/test-reporter
RUN chmod +x /usr/local/bin/test-reporter

ENV TEST_REPORTER_HOST=0.0.0.0
ENV TEST_REPORTER_PORT=3099
EXPOSE 3099

CMD ["test-reporter", "serve"]
