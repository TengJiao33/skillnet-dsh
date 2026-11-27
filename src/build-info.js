import manifest from '../package.json' with { type: 'json' };

export const PACKAGE_VERSION = manifest.version;
export const BUILD_REVISION = PACKAGE_VERSION;
