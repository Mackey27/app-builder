FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openjdk-17-jdk \
    unzip \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools

# Update this arg if Google revs the commandline-tools package id.
ARG ANDROID_CMDLINE_TOOLS_VERSION=11076708
ARG GRADLE_VERSION=9.3.1

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && wget -q "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -f /tmp/cmdline-tools.zip

RUN yes | sdkmanager --licenses >/dev/null
RUN sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
RUN npm install -g cordova@12

RUN mkdir -p /opt/gradle \
    && wget -q "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -O /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt/gradle \
    && rm -f /tmp/gradle.zip
ENV PATH=${PATH}:/opt/gradle/gradle-${GRADLE_VERSION}/bin

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/builds

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
