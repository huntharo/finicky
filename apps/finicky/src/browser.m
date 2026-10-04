
#include "browser.h"
#import <Cocoa/Cocoa.h>
#import <stdlib.h>

const char* getDefaultHandlerForURLScheme(const char* scheme) {
    @autoreleasepool {
        if (!scheme) return NULL;

        // Convert C string to NSString
        NSString *schemeStr = [NSString stringWithUTF8String:scheme];
        if (!schemeStr) return NULL;

        // Create an NSURL with the scheme
        NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@://", schemeStr]];

        // Get the default application URL for the scheme
        NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
        NSURL *appURL = [workspace URLForApplicationToOpenURL:url];

        if (appURL) {
            const char *result = [appURL.path UTF8String];
            // NSLog(@"Default application URL for scheme '%@': %@", schemeStr, appURL.path);
            // Get the bundle identifier for the application at appURL
            NSBundle *appBundle = [NSBundle bundleWithURL:appURL];
            NSString *bundleId = [appBundle bundleIdentifier];
            if (bundleId) {
                // NSLog(@"Bundle ID for application: %@", bundleId);
                return strdup([bundleId UTF8String]); // Convert NSString to C string and return a copy
            } else {
                // NSLog(@"Failed to get Bundle ID for application at URL: %@", appURL.path);
            }
            return NULL;
        }

        return NULL;
    }
}

bool setDefaultHandlerForURLScheme(const char* bundleId, const char* scheme) {
    @autoreleasepool {
        if (!bundleId || !scheme) return false;

        // Convert C strings to NSString
        NSString *bundleIdStr = [NSString stringWithUTF8String:bundleId];
        NSString *schemeStr = [NSString stringWithUTF8String:scheme];

        // Create an NSURL with the scheme
        NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%@://", schemeStr]];

        // Get the URL for the application with the given bundle ID
        NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
        // NSURL *appURL = [workspace URLForApplicationWithBundleIdentifier:bundleIdStr];
        NSBundle *mainBundle = [NSBundle mainBundle];
        NSURL *appURL = mainBundle.bundleURL;

        if (!appURL) {
            NSLog(@"Failed to find application with bundle ID: %@", bundleIdStr);
            return false;
        }
        
        // Check if appURL contains ".app"
        // if (![appURL.path containsString:@".app"]) {
        //     NSLog(@"The application URL does not contain '.app': %@", appURL.path);
        //     return false;
        // }

        NSLog(@"Setting default application: %@", appURL);
        NSLog(@"Setting default application for scheme: %@", schemeStr);
        [workspace setDefaultApplicationAtURL:appURL toOpenURLsWithScheme:schemeStr completionHandler:^(NSError *error) {
            if (error) {
                NSLog(@"Error setting default handler: %@", error);
            } else {
                NSLog(@"Successfully set default handler for scheme: %@", schemeStr);
            }
        }];
        
        return true;
    }
}

// Runtime identity plus path APIs for the explicit developer handler CLI.
const char* currentApplicationPath(void) {
    return strdup([[[NSBundle mainBundle] bundlePath] UTF8String]);
}
const char* currentBundleIdentifier(void) {
    NSString *identifier = [[NSBundle mainBundle] bundleIdentifier];
    return identifier ? strdup([identifier UTF8String]) : NULL;
}
bool isDevelopmentBundle(void) {
    return [[[[NSBundle mainBundle] infoDictionary] objectForKey:@"FinickyDevelopment"] boolValue];
}
const char* defaultApplicationPath(const char* scheme) {
    @autoreleasepool {
        NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"%s://", scheme]];
        NSURL *app = [[NSWorkspace sharedWorkspace] URLForApplicationToOpenURL:url];
        return app ? strdup([app.path UTF8String]) : NULL;
    }
}
bool registerApplication(const char* path) {
    @autoreleasepool {
        return LSRegisterURL((__bridge CFURLRef)[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]], true) == noErr;
    }
}
bool setDefaultApplicationPath(const char* path, const char* scheme) {
    @autoreleasepool {
        NSURL *app = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
        if (![[NSFileManager defaultManager] fileExistsAtPath:app.path]) return false;
        dispatch_semaphore_t completion = dispatch_semaphore_create(0);
        __block BOOL succeeded = NO;
        [[NSWorkspace sharedWorkspace] setDefaultApplicationAtURL:app
            toOpenURLsWithScheme:[NSString stringWithUTF8String:scheme]
            completionHandler:^(NSError *error) {
                succeeded = (error == nil);
                dispatch_semaphore_signal(completion);
                if (error) NSLog(@"URL handler change failed: %@", error);
            }];
        // CLI runs on the locked main OS thread, before NSApp.run. Pump its
        // run loop so the asynchronous completion can be observed and verified.
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
        while (dispatch_semaphore_wait(completion, DISPATCH_TIME_NOW) != 0) {
            if ([deadline timeIntervalSinceNow] <= 0) return false;
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
        return succeeded;
    }
}
