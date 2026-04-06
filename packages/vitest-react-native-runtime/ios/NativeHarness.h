#import <UIKit/UIKit.h>

#ifdef __cplusplus
#import <NativeHarnessSpec/NativeHarnessSpec.h>
#endif

#ifdef __cplusplus
@interface NativeHarness : NSObject <NativeNativeHarnessSpec>
#else
@interface NativeHarness : NSObject
#endif
+ (UIWindow * _Nullable)activeWindow;
@end
