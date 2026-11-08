FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
# The app runs TypeScript through tsx. Its postinstall builds the isolated
# PowerScale package, so retain the development dependencies in this trial.
RUN npm ci --include=dev
USER node
EXPOSE 5230
HEALTHCHECK --interval=15s --timeout=4s --start-period=90s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5230/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "run", "be:server"]
