package demo;

public class BuilderCaller {
    public LombokUser make() {
        LombokUser u = LombokUser.builder().build();
        return u;
    }
}
