# Build 5 Class B native-Back diagnostic probe.
# INTERNAL TESTFLIGHT DIAGNOSTIC ONLY, NEVER PROMOTE TO CUSTOMER RELEASE.
# Compiled into every native build by expo-modules-autolinking (./modules is
# the default native modules directory), so the section 16 removal gate of
# docs/build5-classb-native-back-diagnostic-plan.md must delete this
# directory before any customer build after Build 6.
Pod::Spec.new do |s|
  s.name           = 'NavProbe'
  s.version        = '1.0.0'
  s.summary        = 'Read-only native Back observation probe (diagnostic build only).'
  s.description    = 'Observes react-native-screens pop-delegate and header ' \
                     'reconfiguration paths on iOS 26 for the Build 5 Class B ' \
                     'native-Back diagnostic. Diagnostic artifact, not a product feature.'
  s.author         = 'Tastelog'
  s.homepage       = 'https://github.com/Bbuju055/tastelog'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
