// Photos drop helper (macOS only): receives the real video when a video is dragged in from
// the Photos app.
//
// Photos puts two things on the drag pasteboard for a video: a file promise for the original
// movie, and a file URL to a JPEG preview frame. Chromium only reads file URLs, so without this
// module a dropped video arrives as that preview and imports as a still. A file promise can only
// be redeemed by the drop target while the drop is being performed, so this module hooks
// performDragOperation: on Chromium's drop target (WebContentsViewCocoa), asks Photos to write
// each promised movie into a fresh folder, and reports progress to JavaScript:
//
//   { type: 'promised', token, previewPath, fileType }   during the drop (main thread)
//   { type: 'received', token, path }                    once Photos has written the movie
//   { type: 'failed',   token, error }                   if Photos could not
//
// The drop itself carries on unchanged, so the renderer still gets the preview path; the main
// process swaps it for the received movie (src/main/photosDrop.ts).
//
// Built by scripts/build-photodrop.mjs into native/photodrop.node. Node-API, so one build
// loads in Node and Electron.

#import <Cocoa/Cocoa.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <string>

namespace {

struct Event {
  std::string type, token, previewPath, fileType, path, error;
};

napi_threadsafe_function g_tsfn = nullptr;
NSString *g_destination = nil;
NSOperationQueue *g_queue = nil;
IMP g_originalPerform = nullptr;

std::string str(NSString *s) { return s ? std::string(s.UTF8String ?: "") : std::string(); }

void setString(napi_env env, napi_value obj, const char *key, const std::string &value) {
  napi_value v;
  napi_create_string_utf8(env, value.c_str(), value.size(), &v);
  napi_set_named_property(env, obj, key, v);
}

void callJs(napi_env env, napi_value callback, void *, void *data) {
  Event *ev = static_cast<Event *>(data);
  if (env && callback) {
    napi_value obj, undefined;
    napi_create_object(env, &obj);
    setString(env, obj, "type", ev->type);
    setString(env, obj, "token", ev->token);
    if (ev->type == "promised") {
      setString(env, obj, "previewPath", ev->previewPath);
      setString(env, obj, "fileType", ev->fileType);
    } else if (ev->type == "received") {
      setString(env, obj, "path", ev->path);
    } else {
      setString(env, obj, "error", ev->error);
    }
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &obj, nullptr);
  }
  delete ev;
}

void emit(Event *ev) {
  if (!g_tsfn || napi_call_threadsafe_function(g_tsfn, ev, napi_tsfn_nonblocking) != napi_ok)
    delete ev;
}

bool isMovie(NSString *identifier) {
  if (!identifier) return false;
  UTType *type = [UTType typeWithIdentifier:identifier];
  return type && [type conformsToType:UTTypeMovie];
}

/** Start receiving every promised movie on the dragging pasteboard. */
void receivePromisedMovies(id<NSDraggingInfo> info) {
  if (!g_destination) return;
  NSPasteboard *pb = [info draggingPasteboard];
  NSArray<NSString *> *promiseTypes = [NSFilePromiseReceiver readableDraggedTypes];

  // readObjectsForClasses: yields one receiver per pasteboard item that holds a promise, in item
  // order; pair them with those items to find each one's preview file URL.
  NSMutableArray<NSPasteboardItem *> *promiseItems = [NSMutableArray array];
  for (NSPasteboardItem *item in pb.pasteboardItems)
    if ([item availableTypeFromArray:promiseTypes]) [promiseItems addObject:item];
  NSArray *receivers = [pb readObjectsForClasses:@[ [NSFilePromiseReceiver class] ] options:nil];
  NSUInteger count = MIN(receivers.count, promiseItems.count);

  for (NSUInteger i = 0; i < count; i++) {
    NSFilePromiseReceiver *receiver = receivers[i];
    NSString *fileType = receiver.fileTypes.firstObject;
    if (!isMovie(fileType)) continue;
    NSString *urlString = [promiseItems[i] stringForType:NSPasteboardTypeFileURL];
    NSString *previewPath = urlString ? [NSURL URLWithString:urlString].path : nil;
    // Without a preview file the renderer gets nothing to import, so there is nothing to swap.
    if (previewPath.length == 0) continue;

    NSString *token = [NSUUID UUID].UUIDString;
    NSString *dir = [g_destination stringByAppendingPathComponent:token];
    if (![[NSFileManager defaultManager] createDirectoryAtPath:dir
                                   withIntermediateDirectories:YES
                                                    attributes:nil
                                                         error:nil])
      continue;

    emit(new Event{"promised", str(token), str(previewPath), str(fileType), "", ""});

    std::string tokenStr = str(token);
    [receiver receivePromisedFilesAtDestination:[NSURL fileURLWithPath:dir isDirectory:YES]
                                        options:@{}
                                 operationQueue:g_queue
                                         reader:^(NSURL *fileURL, NSError *error) {
                                           if (error)
                                             emit(new Event{"failed", tokenStr, "", "", "",
                                                            str(error.localizedDescription)});
                                           else
                                             emit(new Event{"received", tokenStr, "", "",
                                                            str(fileURL.path), ""});
                                         }];
  }
}

BOOL performDragOperationHook(id self, SEL cmd, id<NSDraggingInfo> info) {
  @try {
    receivePromisedMovies(info);
  } @catch (NSException *) {
    // Never let this break a drop; the preview still imports as before.
  }
  return reinterpret_cast<BOOL (*)(id, SEL, id<NSDraggingInfo>)>(g_originalPerform)(self, cmd,
                                                                                     info);
}

napi_value throwError(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

/** install(destinationDir: string, onEvent: (event) => void): void. Call once. */
napi_value Install(napi_env env, napi_callback_info cbinfo) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, nullptr);
  if (argc < 2) return throwError(env, "install(destinationDir, onEvent) needs two arguments");
  if (g_tsfn) return throwError(env, "Photos drop helper is already installed");

  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len) != napi_ok)
    return throwError(env, "destinationDir must be a string");
  std::string dest(len, '\0');
  napi_get_value_string_utf8(env, argv[0], dest.data(), len + 1, &len);

  Class cls = NSClassFromString(@"WebContentsViewCocoa");
  SEL sel = @selector(performDragOperation:);
  Method method = cls ? class_getInstanceMethod(cls, sel) : nullptr;
  if (!method) return throwError(env, "Chromium's drop target was not found");

  napi_value name;
  napi_create_string_utf8(env, "veejus-photodrop", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, name, 0, 1, nullptr, nullptr,
                                      nullptr, callJs, &g_tsfn) != napi_ok)
    return throwError(env, "Could not create the event callback");
  napi_unref_threadsafe_function(env, g_tsfn); // don't keep the process alive

  g_destination = [NSString stringWithUTF8String:dest.c_str()];
  g_queue = [[NSOperationQueue alloc] init];

  // Hook the class's own method; if it only inherits one, add an override that calls up.
  IMP original = method_getImplementation(method);
  if (class_addMethod(cls, sel, reinterpret_cast<IMP>(performDragOperationHook),
                      method_getTypeEncoding(method)))
    g_originalPerform = original;
  else
    g_originalPerform =
        method_setImplementation(method, reinterpret_cast<IMP>(performDragOperationHook));

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, Install, nullptr, &fn);
  napi_set_named_property(env, exports, "install", fn);
  return exports;
}
