# Apify base image for Node.js actors
FROM apify/actor-node:20

# Copy package files first (for Docker layer caching)
COPY package*.json ./

# Install dependencies
RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional

# Copy the rest of the source
COPY . ./

# Default command
CMD npm start --silent
