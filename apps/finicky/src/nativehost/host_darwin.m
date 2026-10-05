//go:build darwin

#import <Cocoa/Cocoa.h>
#import <CoreServices/CoreServices.h>
#include <stdlib.h>
extern void PwrOpenURL(char *,char *,char *,char *,double);
extern void PwrShowSettings(void);
extern void PwrQuit(void);
extern void PwrDefaultFinished(char *);

@interface PwrDelegate:NSObject<NSApplicationDelegate>
@property BOOL receivedURL;
@property BOOL showOnStart;
@property NSUInteger urlSequence;
@property NSTimeInterval lastURLTime;
@property(strong) NSStatusItem *status;
@end
@implementation PwrDelegate
- (void)applicationWillFinishLaunching:(NSNotification *)note {
 [[NSAppleEventManager sharedAppleEventManager] setEventHandler:self andSelector:@selector(receiveURL:reply:) forEventClass:kInternetEventClass andEventID:kAEGetURL];
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
 self.status=[[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
 self.status.button.title=@"PF";
 self.status.button.toolTip=@"PwrFinicky — browser routing";
 NSMenu *menu=[[NSMenu alloc]init];
 NSMenuItem *settings=[[NSMenuItem alloc]initWithTitle:@"PwrFinicky Settings…" action:@selector(settings:) keyEquivalent:@","];
 settings.target=self;[menu addItem:settings];[menu addItem:[NSMenuItem separatorItem]];
 NSMenuItem *quit=[[NSMenuItem alloc]initWithTitle:@"Quit PwrFinicky" action:@selector(quit:) keyEquivalent:@"q"];quit.target=self;[menu addItem:quit];self.status.menu=menu;
 // A cold URL launch receives its AppleEvent during app startup. It must never
 // open the settings UI merely because this is the first invocation.
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC),dispatch_get_main_queue(),^{if(self.showOnStart&&!self.receivedURL)PwrShowSettings();});
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)visible {
 // Launch Services can send reopen beside a URL event. Coalesce that event
 // burst before treating a reopen as an explicit request for settings.
 NSUInteger sequence=self.urlSequence;
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
  if(sequence==self.urlSequence&&NSProcessInfo.processInfo.systemUptime-self.lastURLTime>0.75)PwrShowSettings();
 });
 return NO;
}
- (void)receiveURL:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply {
 NSTimeInterval receipt=NSProcessInfo.processInfo.systemUptime;
 self.receivedURL=YES;
 self.urlSequence++;
 self.lastURLTime=NSProcessInfo.processInfo.systemUptime;
 NSString *url=[[event paramDescriptorForKeyword:keyDirectObject] stringValue];
 if(!url)return;
 pid_t pid=[[event attributeDescriptorForKeyword:keySenderPIDAttr] int32Value];
 NSRunningApplication *sender=pid>0?[NSRunningApplication runningApplicationWithProcessIdentifier:pid]:nil;
 // Sender identity is cheap. No synchronous Accessibility query is made here.
 NSString *name=sender.localizedName?:@"", *identifier=sender.bundleIdentifier?:@"", *path=sender.executableURL.path?:@"";
 PwrOpenURL((char*)url.UTF8String,(char*)name.UTF8String,(char*)identifier.UTF8String,(char*)path.UTF8String,(NSProcessInfo.processInfo.systemUptime-receipt)*1000);
}
- (void)settings:(id)sender{PwrShowSettings();}
- (void)quit:(id)sender{PwrQuit();}
@end

static PwrDelegate *delegate;
void pwrRun(int show){@autoreleasepool{[NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];delegate=[PwrDelegate new];delegate.showOnStart=show;NSApp.delegate=delegate;[NSApp run];}}
void pwrStop(void){dispatch_async(dispatch_get_main_queue(),^{[NSApp stop:nil];NSEvent *event=[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];[NSApp postEvent:event atStart:YES];});}
char *pwrDefaultStatus(void){@autoreleasepool{
 NSString *http=CFBridgingRelease(LSCopyDefaultHandlerForURLScheme(CFSTR("http")))?:@"";
 NSString *https=CFBridgingRelease(LSCopyDefaultHandlerForURLScheme(CFSTR("https")))?:@"";
 NSString *identifier=NSBundle.mainBundle.bundleIdentifier?:@"com.pwrdrvr.pwrfinicky";
 NSDictionary *result=@{@"http":http,@"https":https,@"isDefault":@((BOOL)([http isEqualToString:identifier]&&[https isEqualToString:identifier]))};
 NSData *json=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];return strdup([[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
}}
static void pwrSetScheme(NSURL *applicationURL, NSArray<NSString *> *schemes, NSUInteger index) {
 if (index == schemes.count) {
  PwrDefaultFinished(NULL);
  return;
 }
 [NSWorkspace.sharedWorkspace setDefaultApplicationAtURL:applicationURL
                                 toOpenURLsWithScheme:schemes[index]
                                    completionHandler:^(NSError *error) {
  if (error) {
   PwrDefaultFinished((char *)error.localizedDescription.UTF8String);
   return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{ pwrSetScheme(applicationURL, schemes, index + 1); });
 }];
}

void pwrSetDefault(void) {
 // NSWorkspace owns the asynchronous system-consent dialog. Keep the native
 // event loop and RPC responsive while the user decides; completion is polled
 // by Settings instead of incorrectly treating an immediate return as success.
 dispatch_async(dispatch_get_main_queue(), ^{
  NSURL *applicationURL = NSBundle.mainBundle.bundleURL;
  if (![applicationURL.pathExtension isEqualToString:@"app"]) {
   PwrDefaultFinished("Launch the packaged PwrFinicky.app before setting the default browser.");
   return;
  }
  OSStatus registered = LSRegisterURL((__bridge CFURLRef)applicationURL, true);
  if (registered != noErr) {
   NSString *message = [NSString stringWithFormat:@"macOS could not register PwrFinicky (%d).", (int)registered];
   PwrDefaultFinished((char *)message.UTF8String);
   return;
  }
  pwrSetScheme(applicationURL, @[@"http", @"https", @"pwrfinicky"], 0);
 });
}
