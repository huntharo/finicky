// browse.h
#import <Cocoa/Cocoa.h>
#include <syslog.h>

const char* getDefaultHandlerForURLScheme(const char* scheme);

bool setDefaultHandlerForURLScheme(const char* bundleId, const char* scheme);

const char* currentApplicationPath(void);
const char* currentBundleIdentifier(void);
bool isDevelopmentBundle(void);
const char* defaultApplicationPath(const char* scheme);
bool registerApplication(const char* path);
bool setDefaultApplicationPath(const char* path, const char* scheme);
