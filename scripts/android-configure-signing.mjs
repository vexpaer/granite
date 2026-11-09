import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const androidRoot = "src-tauri/gen/android";
const appRoot = join(androidRoot, "app");
const gradlePath = join(appRoot, "build.gradle.kts");
const keystorePath = join(appRoot, "granite-release.jks");
const propertiesPath = join(appRoot, "keystore.properties");

const required = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing required GitHub Actions secret: ${name}`);
  }
}

if (!existsSync(gradlePath)) {
  throw new Error(`Generated Android Gradle file is missing: ${gradlePath}`);
}

const keystore = Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, "base64");
if (keystore.length < 64) {
  throw new Error("ANDROID_KEYSTORE_BASE64 did not decode to a usable keystore");
}
writeFileSync(keystorePath, keystore, { mode: 0o600 });
chmodSync(keystorePath, 0o600);

function propertyValue(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

const properties = [
  "storeFile=granite-release.jks",
  `storePassword=${propertyValue(process.env.ANDROID_KEYSTORE_PASSWORD)}`,
  `keyAlias=${propertyValue(process.env.ANDROID_KEY_ALIAS)}`,
  `keyPassword=${propertyValue(process.env.ANDROID_KEY_PASSWORD)}`,
  "",
].join("\n");
writeFileSync(propertiesPath, properties, { mode: 0o600 });
chmodSync(propertiesPath, 0o600);

let gradle = readFileSync(gradlePath, "utf8");
if (!gradle.includes("graniteKeystoreProperties")) {
  const marker = [
    "val tauriProperties = Properties().apply {",
    '    val propFile = file("tauri.properties")',
    "    if (propFile.exists()) {",
    "        propFile.inputStream().use { load(it) }",
    "    }",
    "}",
  ].join("\n");
  if (!gradle.includes(marker)) {
    throw new Error("Unrecognized Tauri Android Gradle template; update the signing patch");
  }
  const insertedProperties = `${marker}

val graniteKeystoreProperties = Properties().apply {
    file("keystore.properties").inputStream().use { load(it) }
}`;
  gradle = gradle.replace(marker, insertedProperties);
}

if (!gradle.includes('signingConfigs.getByName("release")')) {
  const androidBlock = "android {\n";
  if (!gradle.includes(androidBlock)) {
    throw new Error("Generated Android Gradle file has no android block");
  }
  gradle = gradle.replace(
    androidBlock,
    `${androidBlock}    signingConfigs {
        create("release") {
            storeFile = file(graniteKeystoreProperties.getProperty("storeFile"))
            storePassword = graniteKeystoreProperties.getProperty("storePassword")
            keyAlias = graniteKeystoreProperties.getProperty("keyAlias")
            keyPassword = graniteKeystoreProperties.getProperty("keyPassword")
        }
    }
`,
  );

  const releaseBlock = /getByName\("release"\)\s*\{/;
  if (!releaseBlock.test(gradle)) {
    throw new Error("Generated Android Gradle file has no release build type");
  }
  gradle = gradle.replace(
    releaseBlock,
    'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")',
  );
}

writeFileSync(gradlePath, gradle);
