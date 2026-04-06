require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name           = "NativeHarness"
  s.version        = package["version"]
  s.summary        = "Native view query and touch synthesis for vitest-react-native-runtime"
  s.homepage       = "https://github.com/test"
  s.license        = "MIT"
  s.author         = "Test"
  s.source         = { git: "" }

  s.platforms      = { :ios => "16.0" }
  s.swift_version  = "5.9"
  s.source_files   = "ios/**/*.{h,m,mm,swift,cpp}"
  s.exclude_files  = "ios/Hammer/Info.plist"

  install_modules_dependencies(s)
end
