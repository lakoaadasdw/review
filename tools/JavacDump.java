import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * 用 JDK 自带 javac 语法树 dump 一份「谁调了谁」的清单，作为硬扫解析器的对照基准。
 * 用法：java JavacDump <root> [out.json]
 * 输出：files / types / methods / invocations（file, line, inClass, inMethod, qualifier, name, arity）
 */
public class JavacDump {
    static final class Rec {
        String file; int line; String inClass; String inMethod; String qualifier; String name; int arity;
        Rec(String f, int l, String c, String m, String q, String n, int a) { file=f; line=l; inClass=c; inMethod=m; qualifier=q; name=n; arity=a; }
    }
    static final List<Rec> invocations = new ArrayList<>();
    static int types = 0, methods = 0;
    static final List<String[]> decls = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        Path root = Paths.get(args[0]).toAbsolutePath().normalize();
        String outPath = args.length > 1 ? args[1] : null;
        List<File> files = new ArrayList<>();
        try (var walk = Files.walk(root)) {
            walk.filter(p -> p.toString().endsWith(".java"))
                .filter(p -> !p.toString().contains(File.separator + "target" + File.separator))
                .filter(p -> !p.toString().contains(File.separator + "build" + File.separator))
                .forEach(p -> files.add(p.toFile()));
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        StandardJavaFileManager fm = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8);
        JavacTask task = (JavacTask) compiler.getTask(null, fm, d -> {}, List.of("-proc:none"), null, fm.getJavaFileObjectsFromFiles(files));
        Iterable<? extends CompilationUnitTree> units = task.parse();

        for (CompilationUnitTree cu : units) {
            String rel = root.relativize(Paths.get(cu.getSourceFile().toUri())).toString().replace(File.separatorChar, '/');
            SourcePositions pos = Trees.instance(task).getSourcePositions();
            LineMap lineMap = cu.getLineMap();
            new TreePathScanner<Void, Void>() {
                final Deque<String> classes = new ArrayDeque<>();
                final Deque<String> methodStack = new ArrayDeque<>();
                String curFile = rel;

                @Override public Void visitClass(ClassTree node, Void v) {
                    types++;
                    classes.push(node.getSimpleName().toString());
                    super.visitClass(node, v);
                    classes.pop();
                    return null;
                }
                @Override public Void visitMethod(MethodTree node, Void v) {
                    methods++;
                    decls.add(new String[]{curFile, String.valueOf(lineMap.getLineNumber(pos.getStartPosition(cu, node))), classes.peek(), node.getName().toString(), String.valueOf(node.getParameters().size())});
                    methodStack.push(node.getName().toString());
                    super.visitMethod(node, v);
                    methodStack.pop();
                    return null;
                }
                @Override public Void visitMethodInvocation(MethodInvocationTree node, Void v) {
                    int line = (int) lineMap.getLineNumber(pos.getStartPosition(cu, node));
                    String name = node.getMethodSelect() instanceof MemberSelectTree ms ? ms.getIdentifier().toString()
                            : node.getMethodSelect() instanceof IdentifierTree id ? id.getName().toString() : "?";
                    String qual = null;
                    if (node.getMethodSelect() instanceof MemberSelectTree ms) {
                        ExpressionTree q = ms.getExpression();
                        qual = q.toString();
                    }
                    invocations.add(new Rec(curFile, line, classes.peek(), methodStack.peek(), qual, name, node.getArguments().size()));
                    return super.visitMethodInvocation(node, v);
                }
            }.scan(cu, null);
        }

        StringBuilder sb = new StringBuilder(1 << 20);
        sb.append("{\"files\":").append(files.size())
          .append(",\"types\":").append(types)
          .append(",\"methods\":").append(methods)
          .append(",\"invocations\":[");
        for (int i = 0; i < invocations.size(); i++) {
            Rec r = invocations.get(i);
            if (i > 0) sb.append(',');
            sb.append("{\"file\":\"").append(esc(r.file))
              .append("\",\"line\":").append(r.line)
              .append(",\"inClass\":\"").append(esc(r.inClass))
              .append("\",\"inMethod\":\"").append(esc(r.inMethod))
              .append("\",\"qualifier\":").append(r.qualifier == null ? "null" : "\"" + esc(r.qualifier) + "\"")
              .append(",\"name\":\"").append(esc(r.name))
              .append("\",\"arity\":").append(r.arity).append('}');
        }
        sb.append("],\"decls\":[");
        for (int i = 0; i < decls.size(); i++) {
            String[] d = decls.get(i);
            if (i > 0) sb.append(',');
            sb.append("{\"file\":\"").append(esc(d[0]))
              .append("\",\"line\":").append(d[1])
              .append(",\"cls\":\"").append(esc(d[2]))
              .append("\",\"name\":\"").append(esc(d[3]))
              .append("\",\"arity\":").append(d[4]).append('}');
        }
        sb.append("]}");
        String json = sb.toString();
        if (outPath != null) Files.writeString(Paths.get(outPath), json, StandardCharsets.UTF_8);
        else System.out.println(json);
    }

    static String esc(String s) {
        if (s == null) return "";
        final char BS = (char) 92;
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') { b.append(BS).append('"'); }
            else if (c == BS) { b.append(BS).append(BS); }
            else if (c == 10) { b.append(BS).append('n'); }
            else if (c == 13) { b.append(BS).append('r'); }
            else if (c == 9) { b.append(BS).append('t'); }
            else b.append(c);
        }
        return b.toString();
    }
}
