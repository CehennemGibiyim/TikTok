FROM node:22-alpine
WORKDIR /app
COPY package.json index.js ./
# Yerel ve port açmayan köprü: host scanner dizini 700/600 olabilir, named
# volume da root'a ait olabilir; bu yüzden root çalışır. Girdi salt-okunur.
CMD ["node", "index.js"]
