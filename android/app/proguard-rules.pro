# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# R8 keep rules. Do not trim one without a build and an on-device check behind
# it: R8 damage surfaces as a crash when a feature is used, not at launch.

# Reached reflectively or by manifest name, so R8 sees no edge to them.
-keep class com.anjouinc.peardrop.** { *; }

# bare-kit / b4a bind to C++ over JNI. A class reached only from native code
# has no incoming reference in the dex graph.
-keep class to.holepunch.bare.** { *; }
-keep class io.holepunch.** { *; }
-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }

# Expo's module registry resolves modules by reflection.
-keep class expo.modules.** { *; }
-keep class * extends expo.modules.core.interfaces.Package { *; }
-keep class * extends expo.modules.kotlin.modules.Module { *; }

# React Native: JS<->native bridge members are reached by name.
-keep,includedescriptorclasses class com.facebook.react.bridge.** { *; }
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod *; }
-keepclassmembers class * { @com.facebook.react.uimanager.annotations.ReactProp *; }
-keep class * extends com.facebook.react.ReactPackage { *; }
-keep class * implements com.facebook.react.ReactPackage { *; }

# A dangling cross-module reference in expo-notifications, not app code; AGP
# emitted these two lines itself.
-dontwarn expo.modules.kotlin.types.JSTypeConverterProvider$ContainerProvider
-dontwarn expo.modules.kotlin.types.JSTypeConverterProvider
