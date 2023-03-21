FROM node:18

WORKDIR /app
COPY package-lock.json .
COPY package.json .
RUN npm install

COPY . .
RUN npx tsc

CMD ["node", "."]