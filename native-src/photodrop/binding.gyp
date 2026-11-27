{
  "targets": [
    {
      "target_name": "photodrop",
      "sources": ["photodrop.mm"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "OTHER_LDFLAGS": ["-framework", "Cocoa", "-framework", "UniformTypeIdentifiers"]
      }
    }
  ]
}
