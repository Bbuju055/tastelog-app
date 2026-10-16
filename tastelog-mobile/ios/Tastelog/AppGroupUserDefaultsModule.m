#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AppGroupUserDefaultsModule, NSObject)
RCT_EXTERN_METHOD(setString:(NSString *)key value:(NSString *)value)
RCT_EXTERN_METHOD(getString:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(remove:(NSString *)key)
@end
